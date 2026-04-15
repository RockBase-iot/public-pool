import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ClientStatisticsService } from '../ORM/client-statistics/client-statistics.service';
import { ClientService } from '../ORM/client/client.service';
import { RpcBlockService } from '../ORM/rpc-block/rpc-block.service';

@Injectable()
export class AppService implements OnModuleInit {

    constructor(
        private readonly clientStatisticsService: ClientStatisticsService,
        private readonly clientService: ClientService,
        private readonly dataSource: DataSource,
        private readonly rpcBlockService: RpcBlockService,
    ) {

    }

    async onModuleInit() {
        //https://phiresky.github.io/blog/2020/sqlite-performance-tuning/
        // synchronous=off is safe in WAL mode, only WAL checkpoints skip FSYNC
        await this.dataSource.query(`PRAGMA synchronous = off;`);
        await this.dataSource.query(`PRAGMA busy_timeout = 30000;`);
        // 512MB DB page cache (negative value = kibibytes)
        await this.dataSource.query(`PRAGMA cache_size = -512000;`);
        // 4GB memory-mapped I/O for faster reads
        await this.dataSource.query(`PRAGMA mmap_size = 4000000000;`);
        // Store temp tables in memory
        await this.dataSource.query(`PRAGMA temp_store = MEMORY;`);
        // Limit WAL file to 64MB before auto-checkpoint
        await this.dataSource.query(`PRAGMA journal_size_limit = 67108864;`);

        if (process.env.NODE_APP_INSTANCE == null || process.env.NODE_APP_INSTANCE == '0') {

            // VACUUM once at startup (after 2 min delay to avoid blocking init)
            setTimeout(async () => {
                try {
                    console.log('Running VACUUM...');
                    await this.dataSource.query(`VACUUM;`);
                    console.log('VACUUM complete');
                } catch (e) {
                    console.error('VACUUM failed:', e.message);
                }
            }, 2 * 60 * 1000);

            setInterval(async () => {
                await this.deleteOldStatistics();
            }, 1000 * 60 * 60);

            setInterval(async () => {
                console.log('Killing dead clients');
                await this.clientService.killDeadClients();
            }, 1000 * 60 * 5);

            setInterval(async () => {
                console.log('Deleting Old Blocks');
                await this.rpcBlockService.deleteOldBlocks();
            }, 1000 * 60 * 60 * 24);

        }

    }

    private async deleteOldStatistics() {
        console.log('Deleting statistics');

        const deletedStatistics = await this.clientStatisticsService.deleteOldStatistics();
        console.log(`Deleted ${deletedStatistics.affected} old statistics`);
        const deletedClients = await this.clientService.deleteOldClients();
        console.log(`Deleted ${deletedClients.affected} old clients`);

    }


}