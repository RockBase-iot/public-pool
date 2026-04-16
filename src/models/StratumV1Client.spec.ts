import { ConfigService } from '@nestjs/config';
import { Socket } from 'net';
import { BehaviorSubject } from 'rxjs';

import { MockRecording1 } from '../../test/models/MockRecording1';
import { AddressSettingsService } from '../ORM/address-settings/address-settings.service';
import { BlocksService } from '../ORM/blocks/blocks.service';
import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { BitcoinRpcService } from '../services/bitcoin-rpc.service';
import { ExternalSharesService } from '../services/external-shares.service';
import { NotificationService } from '../services/notification.service';
import { StratumV1JobsService } from '../services/stratum-v1-jobs.service';
import { IBlockTemplate } from './bitcoin-rpc/IBlockTemplate';
import { StratumV1Client } from './StratumV1Client';

jest.mock('./validators/bitcoin-address.validator', () => ({
    IsBitcoinAddress() {
        return jest.fn();
    },
}));

describe('StratumV1Client', () => {
    let socket: Socket;
    let stratumV1JobsService: StratumV1JobsService;
    let bitcoinRpcService: Partial<BitcoinRpcService>;

    let clientService: Partial<ClientService>;
    let clientStatisticsService: Partial<ClientStatisticsService>;
    let notificationService: Partial<NotificationService>;
    let blocksService: Partial<BlocksService>;
    let configService: Partial<ConfigService>;
    let addressSettingsService: Partial<AddressSettingsService>;
    let externalSharesService: Partial<ExternalSharesService>;

    let client: StratumV1Client;
    let socketEmitter: (...args: any[]) => void;
    let newBlockTemplateEmitter: BehaviorSubject<IBlockTemplate>;

    beforeEach(() => {
        newBlockTemplateEmitter = new BehaviorSubject<IBlockTemplate>(MockRecording1.BLOCK_TEMPLATE);

        clientService = {
            insert: jest.fn().mockResolvedValue({ id: 'client-uuid-123', address: 'tb1q...', clientName: 'bitaxe3', userAgent: 'bitaxe v2.2', sessionId: MockRecording1.EXTRA_NONCE, bestDifficulty: 0 }),
            delete: jest.fn().mockResolvedValue(undefined),
            connectedClientCount: jest.fn().mockResolvedValue(1),
            heartbeatBulkAsync: jest.fn(),
            updateBestDifficulty: jest.fn().mockResolvedValue(undefined),
        };

        clientStatisticsService = {
            insert: jest.fn().mockResolvedValue(undefined),
            updateBulkAsync: jest.fn(),
        };

        addressSettingsService = {
            getSettings: jest.fn().mockResolvedValue({ address: 'tb1q...', bestDifficulty: 0 }),
            updateBestDifficulty: jest.fn().mockResolvedValue(undefined),
        };

        configService = {
            get: jest.fn((key: string) => {
                switch (key) {
                    case 'DEV_FEE_ADDRESS':
                        return 'tb1qumezefzdeqqwn5zfvgdrhxjzc5ylr39uhuxcz4';
                    case 'NETWORK':
                        return 'testnet';
                    case 'EXTERNAL_SHARE_SUBMISSION_ENABLED':
                        return 'false';
                }
                return null;
            })
        };

        notificationService = {
            notifySubscribersBlockFound: jest.fn(),
        };

        blocksService = {
            save: jest.fn(),
        };

        externalSharesService = {
            submitShare: jest.fn(),
        };

        bitcoinRpcService = {
            newBlockTemplate$: newBlockTemplateEmitter.asObservable(),
            miningInfo: { blocks: 12345 } as any,
            SUBMIT_BLOCK: jest.fn().mockResolvedValue('SUCCESS!'),
        };

        stratumV1JobsService = new StratumV1JobsService(bitcoinRpcService as any);

        socket = new Socket();
        jest.spyOn(socket, 'on').mockImplementation((event: string, listener: (...args: any[]) => void) => {
            if (event === 'data') {
                socketEmitter = listener;
            }
            return socket;
        });
        socket.end = jest.fn() as any;
        socket.destroy = jest.fn() as any;

        client = new StratumV1Client(
            socket,
            stratumV1JobsService,
            bitcoinRpcService as any,
            clientService as any,
            clientStatisticsService as any,
            notificationService as any,
            blocksService as any,
            configService as any,
            addressSettingsService as any,
            externalSharesService as any
        );

        client.extraNonceAndSessionId = MockRecording1.EXTRA_NONCE;

        jest.useFakeTimers({ advanceTimers: true });
    });

    afterEach(async () => {
        await client.destroy();
        jest.useRealTimers();
    });

    it('should subscribe to socket', () => {
        expect(socket.on).toHaveBeenCalled();
    });

    it('should close socket on invalid JSON', async () => {
        socketEmitter(Buffer.from('INVALID\n'));
        await new Promise(r => setImmediate(r));
        expect(client['isDestroyed']).toBe(true);
    });

    it('should respond to mining.subscribe', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data: any) => true);

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));

        await new Promise((r) => setTimeout(r, 1));

        expect(socket.write).toHaveBeenCalledWith(
            `{"id":1,"error":null,"result":[[["mining.notify","${client.extraNonceAndSessionId}"]],"${client.extraNonceAndSessionId}",4]}\n`,
            expect.any(Function)
        );
    });

    it('should respond to mining.configure', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data: any) => true);

        socketEmitter(Buffer.from(MockRecording1.MINING_CONFIGURE));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(
            `{"id":2,"error":null,"result":{"version-rolling":true,"version-rolling.mask":"1fffe000"}}\n`,
            expect.any(Function)
        );
    });

    it('should respond to mining.authorize', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data: any) => true);

        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(
            '{"id":3,"error":null,"result":true}\n',
            expect.any(Function)
        );
    });

    it('should respond to mining.suggest_difficulty', async () => {
        jest.spyOn(socket, 'write').mockImplementation((data: any) => true);

        socketEmitter(Buffer.from(MockRecording1.MINING_SUGGEST_DIFFICULTY));
        await new Promise((r) => setTimeout(r, 1));
        expect(socket.write).toHaveBeenCalledWith(
            `{"id":null,"method":"mining.set_difficulty","params":[512]}\n`,
            expect.any(Function)
        );
    });

    it('should set difficulty', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data: any) => Promise.resolve(true));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(
            expect.stringContaining('"method":"mining.set_difficulty"')
        );
    });

    it('should save client on first share submission', async () => {
        jest.spyOn(client as any, 'write').mockImplementation((data: any) => Promise.resolve(true));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_SUGGEST_DIFFICULTY));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 100));

        newBlockTemplateEmitter.next(MockRecording1.BLOCK_TEMPLATE);
        await new Promise((r) => setTimeout(r, 100));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));
        await new Promise((r) => setTimeout(r, 500));

        expect(clientService.insert).toHaveBeenCalled();
    });

    it('should send job and respond to submission', async () => {
        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);
        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((data: any) => Promise.resolve(true));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_SUGGEST_DIFFICULTY));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));

        await new Promise((r) => setTimeout(r, 100));

        // Emit a block template so the job service produces a mining job
        newBlockTemplateEmitter.next(MockRecording1.BLOCK_TEMPLATE);

        await new Promise((r) => setTimeout(r, 100));

        expect((client as any).write).toHaveBeenCalledWith(
            expect.stringContaining('"method":"mining.notify"')
        );

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));

        await new Promise((r) => setTimeout(r, 500));

        // Should receive some response to the submit (success or error)
        expect((client as any).write).toHaveBeenCalledWith(
            expect.stringContaining('"id":5')
        );
    });

    it('should reject duplicate shares', async () => {
        const date = new Date(parseInt(MockRecording1.TIME, 16) * 1000);
        jest.setSystemTime(date);

        jest.spyOn(client as any, 'write').mockImplementation((data: any) => Promise.resolve(true));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBSCRIBE));
        socketEmitter(Buffer.from(MockRecording1.MINING_AUTHORIZE));
        await new Promise((r) => setTimeout(r, 100));

        newBlockTemplateEmitter.next(MockRecording1.BLOCK_TEMPLATE);
        await new Promise((r) => setTimeout(r, 100));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));
        await new Promise((r) => setTimeout(r, 100));

        socketEmitter(Buffer.from(MockRecording1.MINING_SUBMIT));

        jest.useRealTimers();
        await new Promise((r) => setTimeout(r, 500));

        expect((client as any).write).toHaveBeenCalledWith(
            expect.stringContaining('Duplicate share')
        );
    });

    it('should disconnect when buffer exceeds max size', () => {
        const destroySpy = jest.spyOn(socket, 'destroy');
        const largeData = 'a'.repeat(1024 * 1024 + 1);
        socketEmitter(Buffer.from(largeData));
        expect(destroySpy).toHaveBeenCalled();
    });
});
