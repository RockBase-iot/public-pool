import { DifficultyUtils } from './difficulty.utils';

describe('DifficultyUtils', () => {
    it('should calculate difficulty for a known header', () => {
        // Genesis block header (mainnet) - first 80 bytes
        const genesisHeader = Buffer.from(
            '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c',
            'hex'
        );

        const result = DifficultyUtils.calculateDifficulty(genesisHeader);

        expect(result.submissionDifficulty).toBeGreaterThan(0);
        expect(result.submissionHash).toBeDefined();
        expect(result.submissionHash.length).toBe(64); // 32 bytes hex
    });

    it('should return consistent hash for same header', () => {
        const header = Buffer.alloc(80, 0xab);
        const result1 = DifficultyUtils.calculateDifficulty(header);
        const result2 = DifficultyUtils.calculateDifficulty(header);

        expect(result1.submissionHash).toEqual(result2.submissionHash);
        expect(result1.submissionDifficulty).toEqual(result2.submissionDifficulty);
    });

    it('should handle header passed as hex string', () => {
        const headerHex = 'ab'.repeat(80);
        const result = DifficultyUtils.calculateDifficulty(headerHex as any);

        expect(result.submissionDifficulty).toBeGreaterThan(0);
        expect(result.submissionHash).toBeDefined();
    });
});
