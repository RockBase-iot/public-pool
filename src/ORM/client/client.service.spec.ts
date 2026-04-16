import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';

import { ClientEntity } from './client.entity';
import { ClientService } from './client.service';

describe('ClientService', () => {
    let service: ClientService;
    let mockRepository: any;
    let mockDataSource: any;

    beforeEach(async () => {
        mockRepository = {
            query: jest.fn().mockResolvedValue(undefined),
            insert: jest.fn().mockResolvedValue({ generatedMaps: [{ id: 'uuid-123' }] }),
            softDelete: jest.fn().mockResolvedValue({ affected: 1 }),
            count: jest.fn().mockResolvedValue(5),
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            createQueryBuilder: jest.fn().mockReturnValue({
                select: jest.fn().mockReturnThis(),
                addSelect: jest.fn().mockReturnThis(),
                groupBy: jest.fn().mockReturnThis(),
                orderBy: jest.fn().mockReturnThis(),
                getRawMany: jest.fn().mockResolvedValue([]),
            }),
        };

        mockDataSource = {
            transaction: jest.fn().mockImplementation(async (isolationLevel, callback) => {
                const manager = {
                    query: jest.fn().mockResolvedValue([]),
                    createQueryBuilder: jest.fn().mockReturnValue({
                        update: jest.fn().mockReturnThis(),
                        set: jest.fn().mockReturnThis(),
                        whereInIds: jest.fn().mockReturnThis(),
                        execute: jest.fn().mockResolvedValue({ affected: 0 }),
                    }),
                };
                return callback(manager);
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ClientService,
                {
                    provide: getRepositoryToken(ClientEntity),
                    useValue: mockRepository,
                },
                {
                    provide: getDataSourceToken(),
                    useValue: mockDataSource,
                },
            ],
        }).compile();

        service = module.get<ClientService>(ClientService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should bulk update heartbeats with validated data', async () => {
        service.heartbeatBulkAsync('uuid-1', 123.45, new Date());
        service.heartbeatBulkAsync('uuid-2', 678.90, new Date());

        await service.doBulkHeartbeatUpdate();

        expect(mockRepository.query).toHaveBeenCalled();
        const queryCall = mockRepository.query.mock.calls[0];
        expect(queryCall[0]).toContain('UPDATE "client_entity"');
        expect(queryCall[1]).toEqual(expect.arrayContaining([
            expect.arrayContaining(['uuid-1', 'uuid-2']),
            expect.arrayContaining([123.45, 678.90]),
            expect.arrayContaining([expect.any(Date), expect.any(Date)]),
        ]));
    });

    it('should skip invalid entries in bulk heartbeat', async () => {
        service.heartbeatBulkAsync('uuid-1', 123.45, new Date());
        // @ts-ignore - intentionally passing bad data
        service.heartbeatBulkAsync('uuid-2', NaN, new Date());

        await service.doBulkHeartbeatUpdate();

        expect(mockRepository.query).toHaveBeenCalled();
        const queryCall = mockRepository.query.mock.calls[0];
        expect(queryCall[1][0]).toEqual(['uuid-1']);
    });

    it('should do nothing when no heartbeats to update', async () => {
        await service.doBulkHeartbeatUpdate();
        expect(mockRepository.query).not.toHaveBeenCalled();
    });

    it('should insert client and return entity with generated id', async () => {
        const partial = { address: 'tb1q...', clientName: 'worker1' } as Partial<ClientEntity>;
        const result = await service.insert(partial);
        expect(result.id).toBe('uuid-123');
    });

    it('should soft delete client by id', async () => {
        await service.delete('uuid-1');
        expect(mockRepository.softDelete).toHaveBeenCalledWith({ id: 'uuid-1' });
    });
});
