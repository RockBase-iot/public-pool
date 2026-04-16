import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import * as bitcoinjs from 'bitcoinjs-lib';
import { useContainer } from 'class-validator';
import { readFileSync, watch } from 'fs';
import * as path from 'path';
import * as ecc from 'tiny-secp256k1';

import { AppModule } from './app.module';

// Global safety nets — log and let pm2 handle restart
process.on('unhandledRejection', (reason: any) => {
  console.error(`[FATAL] Unhandled Promise Rejection: ${reason?.stack || reason}`);
  // Exit so pm2 can restart a clean process; lingering in unknown state is worse
  setTimeout(() => process.exit(1), 1000);
});

process.on('uncaughtException', (error: Error) => {
  console.error(`[FATAL] Uncaught Exception: ${error.stack || error.message}`);
  // Give pm2 time to capture the log then exit
  setTimeout(() => process.exit(1), 1000);
});

async function bootstrap() {
  if (process.env.API_PORT == null) {
    console.error('It appears your environment is not configured, create and populate an .env file.');
    return;
  }

  const secure = process.env.API_SECURE?.toLowerCase() === 'true';
  const currentDirectory = process.cwd();
  const keyPath = path.join(currentDirectory, 'secrets', 'key.pem');
  const certPath = path.join(currentDirectory, 'secrets', 'cert.pem');

  let options: any = {};
  if (secure) {
    options = {
      https: {
        key: readFileSync(keyPath),
        cert: readFileSync(certPath),
      }
    };
  }

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(options));
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      //forbidNonWhitelisted: true,
      //forbidUnknownValues: true
    }),
  );

  process.on('SIGINT', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`Stopping services`);
    process.exit(0);
  });

  app.enableCors();
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Taproot
  bitcoinjs.initEccLib(ecc);

  await app.listen(process.env.API_PORT, '0.0.0.0', (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`API listening on ${address}`);
  });

  // --- Live-reload TLS certs/keys when they change on disk ---
  if (secure) {
    // Fastify's underlying Node https server
    const server: any = app.getHttpServer();

    // Guard: only HTTPS servers expose setSecureContext
    if (typeof server?.setSecureContext === 'function') {
      let reloadTimer: NodeJS.Timeout | null = null;

      const scheduleReload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        // Debounce multiple fs events during a single write/replace
        reloadTimer = setTimeout(() => {
          try {
            const key = readFileSync(keyPath);
            const cert = readFileSync(certPath);
            server.setSecureContext({ key, cert });
            console.log(`[TLS] Reloaded certificate @ ${new Date().toISOString()}`);
          } catch (e) {
            console.error('[TLS] Failed to reload certificate:', e);
          }
        }, 500);
      };

      // Watch both files; handle 'change' and 'rename' (rename often fired on atomic replace)
      try {
        watch(keyPath, { persistent: true }, scheduleReload);
        watch(certPath, { persistent: true }, scheduleReload);
        console.log('[TLS] Watching cert/key for changes');
      } catch (e) {
        console.error('[TLS] Failed to watch cert/key files:', e);
      }
    } else {
      console.warn('[TLS] Dynamic cert reload not available (non-HTTPS server?)');
    }
  }
}

bootstrap();
