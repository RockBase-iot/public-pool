import { Test, TestingModule } from '@nestjs/testing';

import { AddressSettingsService } from '../../ORM/address-settings/address-settings.service';
import { ClientStatisticsService } from '../../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../../ORM/client/client.service';
import { ClientController } from './client.controller';

describe('ClientController', () => {
  let controller: ClientController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ClientController],
      providers: [
        {
          provide: ClientService,
          useValue: {
            getByName: jest.fn(),
            getByAddress: jest.fn(),
            getBySessionId: jest.fn(),
          },
        },
        {
          provide: ClientStatisticsService,
          useValue: {
            getChartDataForGroup: jest.fn(),
            getHashRateForGroup: jest.fn(),
            getChartDataForSession: jest.fn(),
            getChartDataForAddress: jest.fn(),
          },
        },
        {
          provide: AddressSettingsService,
          useValue: {
            getSettings: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ClientController>(ClientController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
