import { ControlPlane } from '#self/control_plane';
import { CapacityManager } from '#self/control_plane/capacity_manager';
import { DefaultController } from '#self/control_plane/controllers';
import { DataPlaneClientManager } from '#self/control_plane/data_plane_client/manager';
import { WorkerStatusReportEvent } from '#self/control_plane/events';
import { WorkerLauncher } from '#self/control_plane/worker_launcher';
import { StateManager } from '#self/control_plane/worker_stats/state_manager';
import { ContainerStatusReport, ControlPlaneEvent } from '#self/lib/constants';
import { FunctionProfileManager } from '#self/lib/function_profile';
import { TurfContainerStates } from '#self/lib/turf';
import * as common from '#self/test/common';
import assert from 'assert';
import mm from 'mm';
import { TestEnvironment } from '../environment';
import { registerWorkers } from '../util';

describe(common.testName(__filename), () => {
  const env = new TestEnvironment({
    createTestClock: true,
  });
  let controlPlane: ControlPlane;
  let stateManager: StateManager;
  let functionProfile: FunctionProfileManager;
  let capacityManager: CapacityManager;
  let workerLauncher: WorkerLauncher;
  let dataPlaneClientManager: DataPlaneClientManager;
  let defaultController: DefaultController;

  beforeEach(async () => {
    controlPlane = env.control;
    stateManager = controlPlane._ctx.getInstance('stateManager');
    functionProfile = controlPlane._ctx.getInstance('functionProfile');
    capacityManager = controlPlane._ctx.getInstance('capacityManager');
    workerLauncher = controlPlane._ctx.getInstance('workerLauncher');
    dataPlaneClientManager = controlPlane._ctx.getInstance(
      'dataPlaneClientManager'
    );
    defaultController = controlPlane._ctx.getInstance('defaultController');
  });

  const brokerData1 = {
    functionName: 'func',
    inspector: false,
    workers: [
      {
        name: 'hello',
        maxActivateRequests: 10,
        activeRequestCount: 1,
      },
      {
        name: 'foo',
        maxActivateRequests: 10,
        activeRequestCount: 6,
      },
    ],
  };

  const brokerData2 = {
    functionName: 'lambda',
    inspector: false,
    workers: [
      {
        name: 'coco',
        maxActivateRequests: 10,
        activeRequestCount: 1,
      },
      {
        name: 'cocos',
        maxActivateRequests: 10,
        activeRequestCount: 3,
      },
      {
        name: 'alibaba',
        maxActivateRequests: 10,
        activeRequestCount: 4,
      },
    ],
  };

  describe('#autoScale()', () => {
    for (let id = 0; id < 2; id++) {
      it(`should auto scale with ${
        id === 0 ? 'enough' : 'not enough'
      } memory`, async () => {
        await functionProfile.set(
          [
            {
              name: 'func',
              url: `file://${__dirname}`,
              runtime: 'aworker',
              signature: 'xxx',
              sourceFile: 'index.js',
            },
            {
              name: 'lambda',
              url: `file://${__dirname}`,
              runtime: 'aworker',
              signature: 'xxx',
              sourceFile: 'index.js',
            },
          ],
          'WAIT'
        );

        env.containerManager.setTestContainers([
          { pid: 1, name: 'hello', status: TurfContainerStates.running },
          { pid: 2, name: 'foo', status: TurfContainerStates.running },
          { pid: 3, name: 'coco', status: TurfContainerStates.running },
          { pid: 4, name: 'cocos', status: TurfContainerStates.running },
          { pid: 5, name: 'alibaba', status: TurfContainerStates.running },
        ]);

        registerWorkers(stateManager.workerStatsSnapshot, [
          {
            funcName: 'func',
            processName: 'hello',
            credential: 'world',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'func',
            processName: 'foo',
            credential: 'bar',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'lambda',
            processName: 'coco',
            credential: 'nut',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'lambda',
            processName: 'cocos',
            credential: '2d',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
          {
            funcName: 'lambda',
            processName: 'alibaba',
            credential: 'seed of hope',
            options: { inspect: false },
            disposable: false,
            toReserve: false,
          },
        ]);

        if (id === 0)
          mm(capacityManager, 'virtualMemoryPoolSize', 512 * 1024 * 1024 * 6);

        stateManager.updateWorkerStatusByReport(
          new WorkerStatusReportEvent({
            functionName: 'func',
            name: 'hello',
            isInspector: false,
            event: ContainerStatusReport.ContainerInstalled,
            requestId: '',
          })
        );

        stateManager.updateWorkerStatusByReport(
          new WorkerStatusReportEvent({
            functionName: 'func',
            name: 'foo',
            isInspector: false,
            event: ContainerStatusReport.ContainerInstalled,
            requestId: '',
          })
        );

        stateManager.updateWorkerStatusByReport(
          new WorkerStatusReportEvent({
            functionName: 'lambda',
            name: 'coco',
            isInspector: false,
            event: ContainerStatusReport.ContainerInstalled,
            requestId: '',
          })
        );

        stateManager.updateWorkerStatusByReport(
          new WorkerStatusReportEvent({
            functionName: 'lambda',
            name: 'cocos',
            isInspector: false,
            event: ContainerStatusReport.ContainerInstalled,
            requestId: '',
          })
        );

        stateManager.updateWorkerStatusByReport(
          new WorkerStatusReportEvent({
            functionName: 'lambda',
            name: 'alibaba',
            isInspector: false,
            event: ContainerStatusReport.ContainerInstalled,

            requestId: '',
          })
        );

        await stateManager.syncWorkerData([brokerData1, brokerData2]);

        stateManager.workerStatsSnapshot!.getWorker(
          'func',
          false,
          'hello'
        )!.data!.activeRequestCount = 10;
        stateManager.workerStatsSnapshot!.getWorker(
          'func',
          false,
          'foo'
        )!.data!.activeRequestCount = 10;
        stateManager.workerStatsSnapshot!.getWorker(
          'lambda',
          false,
          'coco'
        )!.data!.activeRequestCount = 3;
        stateManager.workerStatsSnapshot!.getWorker(
          'lambda',
          false,
          'cocos'
        )!.data!.activeRequestCount = 1;
        stateManager.workerStatsSnapshot!.getWorker(
          'lambda',
          false,
          'alibaba'
        )!.data!.activeRequestCount = 2;
        stateManager.workerStatsSnapshot!.getBroker(
          'lambda',
          false
        )!.redundantTimes = 60;

        let tryLaunchCalled = 0;
        let reduceCapacityCalled = 0;
        let stopWorkerCalled = 0;
        mm(
          workerLauncher,
          'tryLaunch',
          async (event: ControlPlaneEvent, { funcName, options }: any) => {
            assert.strictEqual(event, ControlPlaneEvent.Expand);
            assert.strictEqual(funcName, 'func');
            assert.deepStrictEqual(options, { inspect: false });
            tryLaunchCalled++;
          }
        );
        mm(
          dataPlaneClientManager,
          'reduceCapacity',
          async (data: { brokers: string | any[] }) => {
            assert.strictEqual(data.brokers.length, 1);
            assert.strictEqual(data.brokers[0].functionName, 'lambda');
            assert.strictEqual(data.brokers[0].inspector, false);
            assert.deepStrictEqual(data.brokers[0].workers, [
              { name: 'cocos', credential: '2d' },
              { name: 'alibaba', credential: 'seed of hope' },
            ]);
            reduceCapacityCalled++;

            const ret = JSON.parse(JSON.stringify(data));
            ret.brokers[0].workers.pop();
            return ret.brokers;
          }
        );
        mm(defaultController, 'stopWorker', async (name: any) => {
          assert.strictEqual(name, 'cocos');
          stopWorkerCalled++;
        });

        await defaultController['autoScale']();

        assert.strictEqual(tryLaunchCalled, id === 0 ? 1 : 0);
        assert.strictEqual(reduceCapacityCalled, 1);
        assert.strictEqual(stopWorkerCalled, 1);
      });
    }

    it('should auto shrink when function not exist in function profile manager', async () => {
      await functionProfile.set(
        [
          {
            name: 'func',
            url: `file://${__dirname}`,
            runtime: 'aworker',
            signature: 'xxx',
            sourceFile: 'index.js',
          },
          {
            name: 'lambda',
            url: `file://${__dirname}`,
            runtime: 'aworker',
            signature: 'xxx',
            sourceFile: 'index.js',
          },
        ],
        'WAIT'
      );

      env.containerManager.setTestContainers([
        { pid: 1, name: 'hello', status: TurfContainerStates.running },
        { pid: 2, name: 'foo', status: TurfContainerStates.running },
        { pid: 3, name: 'coco', status: TurfContainerStates.running },
        { pid: 4, name: 'cocos', status: TurfContainerStates.running },
        { pid: 5, name: 'alibaba', status: TurfContainerStates.running },
      ]);

      registerWorkers(stateManager.workerStatsSnapshot, [
        {
          funcName: 'func',
          processName: 'hello',
          credential: 'world',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
        {
          funcName: 'func',
          processName: 'foo',
          credential: 'bar',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
        {
          funcName: 'lambda',
          processName: 'coco',
          credential: 'nut',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
        {
          funcName: 'lambda',
          processName: 'cocos',
          credential: '2d',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
        {
          funcName: 'lambda',
          processName: 'alibaba',
          credential: 'seed of hope',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
      ]);

      await functionProfile.set([], 'WAIT');

      stateManager.updateWorkerStatusByReport(
        new WorkerStatusReportEvent({
          functionName: 'func',
          name: 'hello',
          isInspector: false,
          event: ContainerStatusReport.ContainerInstalled,
          requestId: '',
        })
      );

      stateManager.updateWorkerStatusByReport(
        new WorkerStatusReportEvent({
          functionName: 'func',
          name: 'foo',
          isInspector: false,
          event: ContainerStatusReport.ContainerInstalled,
          requestId: '',
        })
      );

      stateManager.updateWorkerStatusByReport(
        new WorkerStatusReportEvent({
          functionName: 'lambda',
          name: 'coco',
          isInspector: false,
          event: ContainerStatusReport.ContainerInstalled,
          requestId: '',
        })
      );

      stateManager.updateWorkerStatusByReport(
        new WorkerStatusReportEvent({
          functionName: 'lambda',
          name: 'cocos',
          isInspector: false,
          event: ContainerStatusReport.ContainerInstalled,
          requestId: '',
        })
      );

      stateManager.updateWorkerStatusByReport(
        new WorkerStatusReportEvent({
          functionName: 'lambda',
          name: 'alibaba',
          isInspector: false,
          event: ContainerStatusReport.ContainerInstalled,
          requestId: '',
        })
      );

      await stateManager.syncWorkerData([brokerData1, brokerData2]);
      stateManager.workerStatsSnapshot!.getWorker(
        'func',
        false,
        'hello'
      )!.data!.activeRequestCount = 10;
      stateManager.workerStatsSnapshot!.getWorker(
        'func',
        false,
        'foo'
      )!.data!.activeRequestCount = 10;
      stateManager.workerStatsSnapshot!.getBroker(
        'func',
        false
      )!.redundantTimes = 60;
      stateManager.workerStatsSnapshot!.getWorker(
        'lambda',
        false,
        'coco'
      )!.data!.activeRequestCount = 3;
      stateManager.workerStatsSnapshot!.getWorker(
        'lambda',
        false,
        'cocos'
      )!.data!.activeRequestCount = 1;
      stateManager.workerStatsSnapshot!.getWorker(
        'lambda',
        false,
        'alibaba'
      )!.data!.activeRequestCount = 2;
      stateManager.workerStatsSnapshot!.getBroker(
        'lambda',
        false
      )!.redundantTimes = 60;

      let tryLaunchCalled = 0;
      let reduceCapacityCalled = 0;
      let stopWorkerCalled = 0;
      mm(workerLauncher, 'tryLaunch', async () => {
        tryLaunchCalled++;
      });
      mm(
        dataPlaneClientManager,
        'reduceCapacity',
        async (data: { brokers: string | any[] }) => {
          assert.strictEqual(data.brokers.length, 2);

          assert.strictEqual(data.brokers[0].functionName, 'func');
          assert.strictEqual(data.brokers[0].inspector, false);
          assert.deepStrictEqual(data.brokers[0].workers, [
            { name: 'foo', credential: 'bar' },
            { name: 'hello', credential: 'world' },
          ]);

          assert.strictEqual(data.brokers[1].functionName, 'lambda');
          assert.strictEqual(data.brokers[1].inspector, false);
          assert.deepStrictEqual(data.brokers[1].workers, [
            { name: 'cocos', credential: '2d' },
            { name: 'alibaba', credential: 'seed of hope' },
            { name: 'coco', credential: 'nut' },
          ]);

          reduceCapacityCalled++;

          return data.brokers;
        }
      );
      let left = ['cocos', 'coco', 'alibaba', 'foo', 'hello'];
      mm(defaultController, 'stopWorker', async (name: string) => {
        assert(left.includes(name));
        left = left.filter(n => name !== n);
        stopWorkerCalled++;
      });

      await defaultController['autoScale']();

      assert.strictEqual(tryLaunchCalled, 0);
      assert.strictEqual(reduceCapacityCalled, 1);
      assert.strictEqual(stopWorkerCalled, 5);
    });

    it('a wrong situation of worker count infinitely increasing', async () => {
      // unexpecated Error: No enough virtual memory (used: 1073741824 + need: 536870912) > total: 1073741824
      //                 at WorkerLauncher.tryLaunch (/usr/local/noslate/control_plane/worker_launcher.js:117:19)
      //                 ...
      //                 at async CapacityManager.#expand (/usr/local/noslate/control_plane/capacity_manager.js:111:5)
      //                 at async CapacityManager.autoScale (/usr/local/noslate/control_plane/capacity_manager.js:200:7)

      // test path:
      //   1. 1gb memory pool
      //   2. 2 workers with per 512mb and maximum activate request count
      //   3. do autoScale()

      env.containerManager.setTestContainers([
        { pid: 1, name: 'hello', status: TurfContainerStates.running },
        { pid: 2, name: 'foo', status: TurfContainerStates.running },
      ]);

      mm(defaultController, 'tryBatchLaunch', async () => {
        throw new Error('Should not be called.');
      });

      await functionProfile.set(
        [
          {
            name: 'func',
            url: `file://${__dirname}`,
            runtime: 'aworker',
            signature: 'xxx',
            sourceFile: 'index.js',
          },
        ],
        'WAIT'
      );

      registerWorkers(stateManager.workerStatsSnapshot, [
        {
          funcName: 'func',
          processName: 'hello',
          credential: 'world',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
        {
          funcName: 'func',
          processName: 'foo',
          credential: 'bar',
          options: { inspect: false },
          disposable: false,
          toReserve: false,
        },
      ]);

      mm(brokerData1.workers[0], 'activeRequestCount', 10);
      mm(brokerData1.workers[1], 'activeRequestCount', 10);
      mm(brokerData1.workers[0], 'resourceLimit', {
        memory: 512 * 1024 * 1024,
      });
      mm(brokerData1.workers[1], 'resourceLimit', {
        memory: 512 * 1024 * 1024,
      });
      mm(capacityManager, 'virtualMemoryPoolSize', 1024 * 1024 * 1024);

      await stateManager.syncWorkerData([brokerData1]);
      await assert.doesNotReject(defaultController['autoScale']());
    });
  });
});
