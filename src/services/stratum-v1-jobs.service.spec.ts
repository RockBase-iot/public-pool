import { Test, TestingModule } from '@nestjs/testing';
import { BehaviorSubject } from 'rxjs';

import { IBlockTemplate } from '../models/bitcoin-rpc/IBlockTemplate';
import { BitcoinRpcService } from './bitcoin-rpc.service';
import { StratumV1JobsService } from './stratum-v1-jobs.service';

describe('StratumV1JobsService', () => {
    let service: StratumV1JobsService;
    let blockTemplateEmitter: BehaviorSubject<IBlockTemplate>;
    let bitcoinRpcService: Partial<BitcoinRpcService>;

    const mockBlockTemplate: IBlockTemplate = {
        capabilities: ['proposal'],
        version: 536870912,
        rules: ['csv', '!segwit', 'taproot'],
        vbavailable: {},
        vbrequired: 0,
        previousblockhash: '00000000000000022246451e9af7ac4f8bff2527d223f6e623740e92171592f2',
        transactions: [],
        coinbasevalue: 1000000000,
        mintime: 1689600000,
        bits: '192495f8',
        height: 12345,
    } as IBlockTemplate;

    beforeEach(async () => {
        blockTemplateEmitter = new BehaviorSubject<IBlockTemplate>(mockBlockTemplate);
        bitcoinRpcService = {
            newBlockTemplate$: blockTemplateEmitter.asObservable(),
            miningInfo: { blocks: 12345 } as any,
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                {
                    provide: BitcoinRpcService,
                    useValue: bitcoinRpcService,
                },
            ],
        }).compile();

        service = new StratumV1JobsService(module.get(BitcoinRpcService));
    });

    afterEach(() => {
        // Clean up subscriptions if any
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should generate incremental job ids', () => {
        const id1 = service.getNextId();
        const id2 = service.getNextId();
        expect(parseInt(id2, 16)).toEqual(parseInt(id1, 16) + 1);
    });

    it('should store and retrieve jobs', () => {
        const mockJob = { jobId: 'abc123', creation: Date.now() } as any;
        service.addJob(mockJob);
        expect(service.getJobById('abc123')).toEqual(mockJob);
    });

    it('should clear jobs and blocks when clearJobs is true', (done) => {
        service.addJob({ jobId: 'old-job', creation: Date.now() } as any);
        service.blocks['old-block'] = { blockData: { creation: Date.now() } } as any;

        let isReplay = true;
        service.newMiningJob$.subscribe((job) => {
            if (isReplay) {
                isReplay = false;
                return;
            }
            if (job && job.blockData.clearJobs) {
                expect(Object.keys(service.jobs).length).toBe(0);
                expect(Object.keys(service.blocks).length).toBe(1); // only the current block
                done();
            }
        });

        // Change block height to trigger clearJobs
        bitcoinRpcService.miningInfo = { blocks: 12346 } as any;
        blockTemplateEmitter.next({ ...mockBlockTemplate, height: 12346 });
    });

    it('should prune old jobs and blocks after 5 minutes', (done) => {
        const now = Date.now();
        service.jobs['stale-job'] = { jobId: 'stale-job', creation: now - 1000 * 60 * 6 } as any;
        service.blocks['stale-block'] = { blockData: { creation: now - 1000 * 60 * 6 } } as any;

        let isReplay = true;
        service.newMiningJob$.subscribe((job) => {
            if (isReplay) {
                isReplay = false;
                return;
            }
            if (job && !job.blockData.clearJobs) {
                expect(service.getJobById('stale-job')).toBeUndefined();
                expect(service.getJobTemplateById('stale-block')).toBeUndefined();
                done();
            }
        });

        blockTemplateEmitter.next(mockBlockTemplate);
    });
});
