import EventEmitter from 'events';
import * as utils from '#self/lib/util';
import { TokenBucket, TokenBucketConfig } from './token_bucket';
import { RpcError, RpcStatus } from '#self/lib/rpc/error';
import { Base } from '#self/lib/sdk_base';
import { PlaneMetricAttributes } from '#self/lib/telemetry/semantic_conventions';
import { Readable } from 'stream';
import { Metadata, TriggerResponse } from '#self/delegate/request_response';
import { NoslatedDelegateService } from '#self/delegate';
import { PrefixedLogger } from '#self/lib/loggers';
import { DataFlowController } from './data_flow_controller';
import * as root from '#self/proto/root';
import { performance } from 'perf_hooks';
import { WorkerStatusReport, kDefaultRequestId } from '#self/lib/constants';
import { DataPlaneHost } from './data_plane_host';
import { List, ReadonlyNode } from '#self/lib/list';
import { RawWithDefaultsFunctionProfile } from '#self/lib/json/function_profile';
import { MinHeap } from '@datastructures-js/heap';

enum RequestQueueStatus {
  PASS_THROUGH = 0,
  QUEUEING = 1,
}

enum CredentialStatus {
  PENDING = 1,
  BOUND = 2,
}

/**
 * The pending request.
 */
export class PendingRequest extends EventEmitter {
  startEpoch: number;
  available: boolean;
  input: Readable | Buffer;
  deferred: utils.Deferred<TriggerResponse>;
  timer: NodeJS.Timeout | undefined;
  requestId: string;

  constructor(
    inputStream: Readable | Buffer,
    public metadata: Metadata,
    deadline: number
  ) {
    super();
    this.startEpoch = Date.now();
    this.available = true;
    this.input = inputStream;
    this.deferred = utils.createDeferred<TriggerResponse>();
    this.requestId = metadata.requestId;
    this.timer = setTimeout(() => {
      this.available = false;
      this.emit('timeout');
    }, deadline - Date.now());
  }

  /**
   * Stop pending timeout timer.
   */
  stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * The promise that may response.
   */
  get promise(): Promise<TriggerResponse> {
    return this.deferred.promise;
  }

  /**
   * Resolve the `promise`.
   */
  get resolve(): (ret: TriggerResponse) => void {
    return this.deferred.resolve;
  }

  /**
   * Reject the `promise`.
   */
  get reject(): (err: Error) => void {
    return this.deferred.reject;
  }
}

// TODO: Reverse control with WorkerBroker.
export class Worker extends EventEmitter {
  activeRequestCount: number;
  private logger: PrefixedLogger;
  trafficOff: boolean;

  freeWorkerListNode: ReadonlyNode<Worker> | null = null;
  debuggerTag: string | undefined;

  constructor(
    public broker: WorkerBroker,
    public delegate: NoslatedDelegateService,
    public name: string,
    public credential: string,
    public disposable: boolean
  ) {
    super();
    this.activeRequestCount = 0;
    this.logger = new PrefixedLogger('worker', this.name);

    // + if `trafficOff` is `false`, then traffic may in;
    // + if `trafficOff` is `true`, then traffic won't in;
    this.trafficOff = false;
  }

  /**
   * Close this worker's traffic.
   */
  async closeTraffic() {
    this.trafficOff = true;

    if (this.activeRequestCount <= 0) {
      return Promise.resolve(true);
    }

    const { promise, resolve } = utils.createDeferred<boolean>();
    const downToZero: (...args: any[]) => void = () => {
      resolve(true);
    };

    this.once('downToZero', downToZero);

    return promise;
  }

  /**
   * Pipe input stream to worker process and get response.
   */
  pipe(inputStream: PendingRequest): Promise<TriggerResponse>;
  pipe(
    inputStream: Readable | Buffer,
    metadata: Metadata
  ): Promise<TriggerResponse>;
  async pipe(
    inputStream: Readable | Buffer | PendingRequest,
    metadata?: Metadata
  ): Promise<TriggerResponse> {
    let waitMs = 0;

    let requestId: string | undefined;

    if (inputStream instanceof PendingRequest) {
      metadata = inputStream.metadata;
      requestId = metadata.requestId;
      waitMs = Date.now() - inputStream.startEpoch;
      inputStream = inputStream.input;
    } else {
      requestId = metadata?.requestId;
    }

    requestId = requestId ?? kDefaultRequestId;
    if (this.disposable && metadata?.debuggerTag) {
      this.debuggerTag = metadata.debuggerTag;
      await this.delegate.inspectorStart(this.credential);
    }

    this.activeRequestCount++;
    this.logger.info(
      '[%s] Dispatching request, activeRequestCount: %s, wait: %sms.',
      requestId,
      this.activeRequestCount,
      waitMs
    );

    try {
      const ret = await this.delegate.trigger(
        this.credential,
        'invoke',
        inputStream,
        metadata || { requestId }
      );

      ret.queueing = waitMs;
      ret.workerName = this.name;

      // do not await the response body finishing.
      ret.finish().finally(() => {
        this.activeRequestCount--;
        if (this.activeRequestCount === 0) {
          this.emit('downToZero');
        }

        this.continueConsumeQueue();
      });

      return ret;
    } catch (e: unknown) {
      if (e instanceof Error) {
        e['queueing'] = waitMs;
        e['workerName'] = this.name;
      }

      throw e;
    }
  }

  continueConsumeQueue() {
    if (this.disposable) return;

    if (this.isWorkerFree()) {
      this.broker.tryConsumeQueue(this);
    }
  }

  isWorkerFree() {
    if (this.trafficOff) {
      return false;
    }

    return this.broker.maxActivateRequests > this.activeRequestCount;
  }
}

interface BrokerOptions {
  inspect?: boolean;
}

interface WorkerItem {
  status: CredentialStatus;
  name: string;
  worker: Worker | null;
}

/**
 * A container that brokers same function's workers.
 */
export class WorkerBroker extends Base {
  public name: string;
  private delegate: NoslatedDelegateService;
  private host: DataPlaneHost;
  private logger: PrefixedLogger;
  requestQueue: List<PendingRequest>;
  private requestQueueStatus: RequestQueueStatus;

  private _workerHeap: Worker[];
  private _workerMap: Map<string, WorkerItem>;
  private tokenBucket: TokenBucket | undefined = undefined;

  /**
   * TODO(chengzhong.wcz): dependency review;
   */
  constructor(
    public dataFlowController: DataFlowController,
    private _profile: RawWithDefaultsFunctionProfile,
    public options: BrokerOptions = {}
  ) {
    super();

    this.name = _profile.name;
    this.delegate = dataFlowController.delegate;
    this.host = dataFlowController.host;

    this.logger = new PrefixedLogger(
      'worker broker',
      `${this.name}${options.inspect ? ':inspect' : ''}`
    );
    this.requestQueue = new List();
    this.requestQueueStatus = RequestQueueStatus.PASS_THROUGH;

    this._workerMap = new Map();
    this._workerHeap = [];

    const rateLimit = this.rateLimit;
    if (rateLimit) {
      this.tokenBucket = new TokenBucket(this.rateLimit as TokenBucketConfig);
    }
  }

  get workerCount() {
    return this._workerMap.size;
  }

  *workers() {
    for (const item of this._workerMap.values()) {
      if (item.worker) {
        yield item.worker;
      }
    }
  }

  /**
   * Get worker via only credential.
   */
  getWorker(credential: string) {
    const item = this._workerMap.get(credential);
    if (item == null) {
      return;
    }

    if (item.worker != null) {
      return item.worker;
    }

    return credential;
  }

  /**
   * Remove a worker via credential.
   */
  removeWorker(credential: string) {
    this._workerMap.delete(credential);
    const idx = this._workerHeap.findIndex(it => it.credential === credential);
    if (idx >= 0) {
      this._workerHeap.splice(idx, 1);
    }
  }

  /**
   * Try consume the pending request queue.
   * @param notThatBusyWorker The idled (not that busy) worker.
   */
  tryConsumeQueue(notThatBusyWorker: Worker) {
    while (this.requestQueue.length) {
      if (!notThatBusyWorker.isWorkerFree()) {
        break;
      }

      const request = this.requestQueue.shift();

      if (!request) continue;

      if (!request.available) continue;

      request.stopTimer();

      notThatBusyWorker
        .pipe(request)
        .then(
          ret => {
            request.resolve(ret);
          },
          err => {
            request.reject(err);
          }
        )
        .finally(() => {
          if (this.disposable) {
            this.closeTraffic(notThatBusyWorker);
          }
        });

      this.dataFlowController.queuedRequestDurationHistogram.record(
        Date.now() - request.startEpoch,
        {
          [PlaneMetricAttributes.FUNCTION_NAME]: this.name,
        }
      );

      // disposable 只消费一个请求
      if (this.disposable) break;
    }

    if (!this.requestQueue.length) {
      this.requestQueueStatus = RequestQueueStatus.PASS_THROUGH;
    }
  }

  async closeTraffic(worker: Worker) {
    try {
      await worker.closeTraffic();

      // 同步 RequestDrained
      this.host.broadcastContainerStatusReport({
        functionName: this.name,
        isInspector: this.options.inspect === true,
        name: worker.name,
        event: WorkerStatusReport.RequestDrained,
      });
    } catch (e) {
      this.logger.error(
        'unexpected error on closing worker traffic (%s, %s)',
        this.name,
        worker.name,
        e
      );
    }
  }

  /**
   * Get the pending credential.
   */
  private isCredentialPending(credential: string) {
    return this._workerMap.get(credential)?.status === CredentialStatus.PENDING;
  }

  /**
   * Register credential to this broker.
   * @param name The worker's name.
   * @param credential The worker's credential.
   */
  registerCredential(name: string, credential: string) {
    if (this.isCredentialPending(credential)) {
      throw new Error(
        `Credential ${credential} already exists in ${this.name}.`
      );
    }
    this._workerMap.set(credential, {
      status: CredentialStatus.PENDING,
      name,
      worker: null,
    });
  }

  updateProfile(profile: RawWithDefaultsFunctionProfile) {
    if (profile.name !== this.name) {
      throw new Error('Update with mismatched worker profile');
    }
    this._profile = profile;
  }

  get disposable() {
    return this._profile.worker.disposable;
  }

  /**
   * Max activate requests count per worker of this broker.
   */
  get maxActivateRequests(): number {
    if (this.disposable) {
      return 1;
    }

    return this._profile.worker.maxActivateRequests;
  }

  /**
   * Rate limit of this broker.
   */
  get rateLimit() {
    return this._profile.rateLimit;
  }

  private get profile() {
    return this._profile;
  }

  get namespace() {
    return this._profile.namespace;
  }

  getWorkerInfo(credential: string) {
    const item = this._workerMap.get(credential);
    return item;
  }

  /**
   * Bind a worker to this broker and initialize.
   * @param credential The worker's credential.
   */
  async bindWorker(credential: string) {
    if (!this._workerMap.has(credential)) {
      this.logger.error(`No credential ${credential} bound to the broker.`);
      return;
    }

    const c = this.isCredentialPending(credential);
    if (!c) {
      throw new Error(
        `Credential ${credential} has not registered in ${this.name} yet.`
      );
    }

    const item = this._workerMap.get(credential);
    if (item == null || item.status !== CredentialStatus.PENDING) {
      this.logger.error(`Duplicated worker with credential ${credential}`);
      return;
    }

    const worker = new Worker(
      this,
      this.delegate,
      item.name,
      credential,
      this.disposable
    );

    try {
      const now = performance.now();
      await this.delegate.trigger(credential, 'init', null, {
        deadline: this.profile.worker.initializationTimeout + Date.now(),
      });
      this.logger.info(
        'worker(%s) initialization cost: %sms.',
        item.name,
        performance.now() - now
      );
      // 同步 Container 状态
      this.host.broadcastContainerStatusReport({
        functionName: this.name,
        isInspector: this.options.inspect === true,
        name: worker.name,
        event: WorkerStatusReport.ContainerInstalled,
      });
    } catch (e: any) {
      this.logger.debug('Unexpected error on invoking initializer', e.message);
      this.delegate.resetPeer(credential);
      throw e;
    }

    this._workerMap.set(credential, {
      status: CredentialStatus.BOUND,
      name: item.name,
      worker,
    });

    this._workerHeap.push(worker);
    this.tryConsumeQueue(worker);
  }

  /**
   * Get an available worker for balancer.
   */
  getAvailableWorker(): Worker | undefined {
    MinHeap.heapify(this._workerHeap, it =>
      it.trafficOff ? Infinity : it.activeRequestCount
    );
    const worker = this._workerHeap[0];
    if (
      worker &&
      !worker.trafficOff &&
      worker.activeRequestCount < this.maxActivateRequests
    ) {
      return worker;
    }
  }

  toJSON(): root.noslated.data.IBrokerStats {
    return {
      functionName: this.name,
      inspector: this.options.inspect === true,
      workers: Array.from(this._workerMap.values()).map(item => ({
        name: item.name,
        activeRequestCount: item.worker?.activeRequestCount ?? 0,
      })),
    };
  }

  /**
   * Create a pending request to the queue.
   * @param input The input stream to be temporarily stored.
   * @param metadata The metadata.
   * @return The created pending request.
   */
  private createPendingRequest(input: Readable | Buffer, metadata: Metadata) {
    this.logger.info('create pending request(%s).', metadata.requestId);
    const request = new PendingRequest(input, metadata, metadata.deadline);
    const node = this.requestQueue.push(request);
    this.dataFlowController.queuedRequestCounter.add(1, {
      [PlaneMetricAttributes.FUNCTION_NAME]: this.name,
    });

    // TODO(kaidi.zkd): 统一计时器定时批量处理超时
    request.once('timeout', () => {
      this.logger.debug('A request wait timeout.');
      this.requestQueue.remove(node);
      request.reject(
        new RpcError(
          `Waiting for worker has timed out at ${metadata.deadline}, request(${request.requestId}).`,
          {
            code: RpcStatus.DEADLINE_EXCEEDED,
          }
        )
      );
      this.dataFlowController.queuedRequestDurationHistogram.record(
        Date.now() - request.startEpoch,
        {
          [PlaneMetricAttributes.FUNCTION_NAME]: this.name,
        }
      );
    });

    // broadcast that there's no enough container
    this.host.broadcastRequestQueueing(this, request.requestId);
    return request;
  }

  /**
   * Check if request queue is enabled.
   */
  #checkRequestQueue(metadata: Metadata) {
    if (!this.profile.worker.disableRequestQueue) return;

    this.host.broadcastRequestQueueing(this, metadata.requestId);
    throw new Error(`No available worker process for ${this.name} now.`);
  }

  /**
   * Fast fail all pendings due to start error
   */
  fastFailAllPendingsDueToStartError(
    startWorkerFastFailRequest: root.noslated.data.IStartWorkerFastFailRequest
  ) {
    // If the error is fatal, reject all pending requests anyway.
    if (
      !startWorkerFastFailRequest.fatal &&
      !this.profile.worker.fastFailRequestsOnStarting
    )
      return;

    const requestQueue = this.requestQueue;
    this.requestQueue = new List();
    const err = new Error(startWorkerFastFailRequest.message!);
    for (const pendingRequest of requestQueue.values()) {
      pendingRequest.stopTimer();
      pendingRequest.reject(err);
      this.dataFlowController.queuedRequestDurationHistogram.record(
        Date.now() - pendingRequest.startEpoch,
        {
          [PlaneMetricAttributes.FUNCTION_NAME]: this.name,
        }
      );
    }
  }

  private _queueRequest(inputStream: Readable | Buffer, metadata: Metadata) {
    this.#checkRequestQueue(metadata);

    this.requestQueueStatus = RequestQueueStatus.QUEUEING;
    const request = this.createPendingRequest(inputStream, metadata);
    return request.promise;
  }

  /**
   * Invoke to an available worker if possible and response.
   */
  async invoke(
    inputStream: Readable | Buffer,
    metadata: Metadata
  ): Promise<TriggerResponse> {
    await this.ready();
    const acquiredToken = this.tokenBucket?.acquire() ?? true;
    if (!acquiredToken) {
      throw new RpcError('rate limit exceeded', {
        code: RpcStatus.RESOURCE_EXHAUSTED,
      });
    }

    switch (this.requestQueueStatus) {
      case RequestQueueStatus.QUEUEING: {
        return this._queueRequest(inputStream, metadata);
      }

      case RequestQueueStatus.PASS_THROUGH: {
        const worker = this.getAvailableWorker();
        if (worker == null) {
          return this._queueRequest(inputStream, metadata);
        }

        let response;

        try {
          response = await worker.pipe(inputStream, metadata);
        } finally {
          if (this.disposable) {
            this.closeTraffic(worker);
          }
        }

        return response;
      }

      default: {
        throw new Error(
          `Request queue status ${this.requestQueueStatus} unreachable.`
        );
      }
    }
  }

  /**
   * Init (override)
   */
  async _init() {
    this.tokenBucket?.start();
  }

  /**
   * Close (override)
   */
  _close() {
    this.tokenBucket?.close();
    // TODO: close all pending & active requests.
  }
}
