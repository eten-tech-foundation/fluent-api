import type { Socket } from 'node:net';

import { Buffer } from 'node:buffer';
import { createServer } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import { afterEach, expect, it, vi } from 'vitest';

const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1LYSALnHEP54X
BimGWkfb4De+bfTYTqaYbPeMP7kNGXlYR9daagHGaO/+gbSQLU9I0qtSdB0Sl2mM
722MkTikQUHOP0X+SQD6BVfg6W8ggLaeoe4j6EdzOuh+4rQvDL4MuhyTvUFNMipa
/SP7IUEjy3iJmUpw7WGFZa9VwUxeACP/CvOADLwjLWdyZZUF8AtJ46N7TXRuUV8E
UXipT2/GcEYIpIfVW2HlxSd9dxs0QHRgK/EHPRb3yjkfhDDWeWV1MZP7vLU4VNFx
dG9Fd5q42vaREkMe7/WSWdFP5WueKKnHTrOZnybPNaDlNVGXPVNfw61bVut186Di
LdTzK+GNAgMBAAECggEABjV+E+sWv+m8a0Z6CYfSOVBzQJqukfO+3rx/QeZuJ+se
hWsi3KjQEKj7ros3fg7Op7l87XZOuvQghfF8anb2/x2mzNPOYrZFEXLTVE3tRPeJ
EQf0hagzoj9bnkhhJR3VhoShry6rDGNcRoixB4c+eJfqWwoIKwIR/g5Imbj/4VaN
OzgeeqSpm3Tzi8pzPOv1JbOkaBq+aXgMPNEuuOULbukMIO1leUlKoZTem70+ZnYz
32mOGtpbw36h74GJ1fVHwdnpScFavoh8izhCw8zWEcJHcdc2GQzZc19Op1xezkEt
AvASXHvevPi+OYPNEtk6Bn+1QSQb/crjfOg8Gh+YgQKBgQDbuBfNqVB61/hw4KdD
E5kbZOwfpymJTxD35/j9kIl11zlytwGFc7HDYLzXAI9bV+RX3Kr08LLxphAWcjxH
GjEzP814eMZgKgteBHVvV5IsgG9aOpgnawdpGSM0lmqTLLCI9EMRoQ9JuP5yrdjR
Vm4y6tsypfQuvhD1OLZdRXnzDQKBgQDTGDd8id3BLLuJa43LVgMyhaZaOauqIKcG
zgl8diKFhehToG4pNjXlYswwhq3XdGJdeIqNN0YluTlapNCgB19FLWvpK0sIdHmN
5z4FzFP/Wv3WyTeco5Mv0en5CYnq9+Q18aJ6U7jSJTZPGXR5EQtkfXy7GnJ1GkQy
U95b3aAIgQKBgFBU4VcPFV6kga/7YwvyKWNLpcz42AXcw45v4KgMZUWRV+6qHENH
hnGxd7l/+enim5jIFDUTn8kb9vvN7l3spJphNGVceuMD3D4WkT0RHl9o4c1yaNjY
l9AEIcwDRpnil/Sqoa7bXPSOT3FsQD5hRE8XcOb2p+1DDn4pqvs1AJ4tAoGAHgkr
E/hV6j+gK4x3L4B8kfq8Ucg06c8dlPVKGkCA5vjHtuZz5j9Fae8l2J3BLI/t0xjs
te0wePui8ofS+4IxBxnQaev0EC7qgMtvYsnRBdt/lMkqtYn8zmgS35GA40MEYLyR
/s/c02HiGV0o2nUXZuQIFGNN9+WV4IdYcz/UnoECgYEAi4wHDr+2GUyhL7JnoTm4
ovtXPI5TAXruus1cS/d2d7PNohArXU4j70XoJxKcqEGz+X8hL/hD6hRfHbkfheiT
HymKbiWxEjSjDiccKRrgDlFIXeLJNqtMGQEqlymZT8WQtKn1VL3m3oioLFmL0s4f
HZAo0DV9GWqGJM6NedbWYxI=
-----END PRIVATE KEY-----`;

const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUDie1eB20ZZBopJl4QcTFNBHhjPswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyMDE2NTkzN1oXDTM2MTAx
NzE2NTkzN1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtS2EgC5xxD+eFwYphlpH2+A3vm302E6mmGz3jD+5DRl5
WEfXWmoBxmjv/oG0kC1PSNKrUnQdEpdpjO9tjJE4pEFBzj9F/kkA+gVX4OlvIIC2
nqHuI+hHczrofuK0Lwy+DLock71BTTIqWv0j+yFBI8t4iZlKcO1hhWWvVcFMXgAj
/wrzgAy8Iy1ncmWVBfALSeOje010blFfBFF4qU9vxnBGCKSH1Vth5cUnfXcbNEB0
YCvxBz0W98o5H4Qw1nlldTGT+7y1OFTRcXRvRXeauNr2kRJDHu/1klnRT+Vrniip
x06zmZ8mzzWg5TVRlz1TX8OtW1brdfOg4i3U8yvhjQIDAQABo28wbTAdBgNVHQ4E
FgQUiEXBBGUQrPp1cNwNtvg3o6XR6n4wHwYDVR0jBBgwFoAUiEXBBGUQrPp1cNwN
tvg3o6XR6n4wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAFsHpWf2ijCAQp3IBi3ri8jzSyVFyAKI
J/YlFfrykKY4eQoyogPrWy4LKnB/rmDfnxO9E02JNcIMjBgodrOpBqZnwW4ehG6S
BqdoRmkueVgtuZdcjuaPxOHB+9t5yB9ihig88ZdAL1yoPOM4ujc1swUglVuJKRq2
CJqHjlxIQKyoHxVjP0Fsk2ssutPAGq4y8tLujkrGSegUif9T8SUGKu6nldr/TVp9
MbAQBcRxsLHDGU1crhE6V82TOMLm/5ft4A3To3Eq/A0twsWEY4Fd5+H6m4jywYIm
59l08mq2i3+hNFm5lAqRfDjusVAK7MG5ZRIVtXmLZiIXp21mw4uOh6M=
-----END CERTIFICATE-----`;

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  process.env.DATABASE_URL = originalDatabaseUrl;
});

function postgresReadyPacket(): Buffer {
  const authentication = Buffer.alloc(9);
  authentication[0] = 0x52;
  authentication.writeInt32BE(8, 1);
  authentication.writeInt32BE(0, 5);
  const backendKey = Buffer.alloc(13);
  backendKey[0] = 75;
  backendKey.writeInt32BE(12, 1);
  backendKey.writeInt32BE(17, 5);
  backendKey.writeInt32BE(29, 9);
  const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
  return Buffer.concat([authentication, backendKey, ready]);
}

it('force-destroys TLS sockets across repeated stalled postgres.js pool retirements', async () => {
  const accepted: Socket[] = [];
  const encrypted: TLSSocket[] = [];
  const queryBytes: number[] = [];
  const secureContext = createSecureContext({ cert: TLS_CERT, key: TLS_KEY });
  const peer = createServer((socket) => {
    accepted.push(socket);
    queryBytes.push(0);
    socket.on('error', () => undefined);
    socket.once('data', (sslRequest) => {
      expect(sslRequest.readInt32BE(0)).toBe(8);
      expect(sslRequest.readInt32BE(4)).toBe(80_877_103);
      socket.write('S');
      const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext });
      encrypted.push(tlsSocket);
      tlsSocket.on('error', () => undefined);
      let startup = Buffer.alloc(0);
      let ready = false;
      tlsSocket.on('data', (chunk) => {
        if (ready) {
          queryBytes[accepted.indexOf(socket)] += chunk.length;
          return;
        }
        startup = Buffer.concat([startup, chunk]);
        if (startup.length < 4 || startup.length < startup.readInt32BE(0)) return;
        ready = true;
        tlsSocket.write(postgresReadyPacket());
      });
    });
  });
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('TCP peer did not bind');
  process.env.DATABASE_URL = `postgresql://probe:probe@127.0.0.1:${address.port}/probe?sslmode=require`;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const { assistantCacheOpenTransportCountForTests, findCompletedBriefing } = await import(
      './cache/assistant-cache.repository'
    );
    for (let generation = 0; generation < 3; generation++) {
      const started = Date.now();
      await expect(findCompletedBriefing(String(generation).repeat(64))).rejects.toThrow(
        'read_timeout'
      );
      expect(Date.now() - started).toBeLessThan(3_000);
      await vi.waitFor(() => {
        expect(accepted).toHaveLength(generation + 1);
        expect(accepted[generation].destroyed).toBe(true);
        expect(encrypted[generation].destroyed).toBe(true);
        expect(assistantCacheOpenTransportCountForTests()).toBe(0);
      });
    }
    expect(queryBytes.every((count) => count > 0)).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    for (const socket of encrypted) socket.destroy();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve()))
    );
  }
}, 15_000);

it('prunes transports after repeated ordinary postgres.js TLS disconnects', async () => {
  const accepted: Socket[] = [];
  const encrypted: TLSSocket[] = [];
  const queryBytes: number[] = [];
  const secureContext = createSecureContext({ cert: TLS_CERT, key: TLS_KEY });
  const peer = createServer((socket) => {
    const connection = accepted.push(socket) - 1;
    queryBytes.push(0);
    socket.on('error', () => undefined);
    socket.once('data', (sslRequest) => {
      expect(sslRequest.readInt32BE(0)).toBe(8);
      expect(sslRequest.readInt32BE(4)).toBe(80_877_103);
      socket.write('S');
      const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext });
      encrypted.push(tlsSocket);
      tlsSocket.on('error', () => undefined);
      let startup = Buffer.alloc(0);
      let ready = false;
      tlsSocket.on('data', (chunk) => {
        if (ready) {
          queryBytes[connection] += chunk.length;
          tlsSocket.destroy();
          return;
        }
        startup = Buffer.concat([startup, chunk]);
        if (startup.length < 4 || startup.length < startup.readInt32BE(0)) return;
        ready = true;
        tlsSocket.write(postgresReadyPacket());
      });
    });
  });
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
  const address = peer.address();
  if (!address || typeof address === 'string') throw new Error('TCP peer did not bind');
  process.env.DATABASE_URL = `postgresql://probe:probe@127.0.0.1:${address.port}/probe?sslmode=require`;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    vi.resetModules();
    const {
      assistantCacheOpenTransportCountForTests,
      assistantCachePoolGenerationForTests,
      findCompletedBriefing,
    } = await import('./cache/assistant-cache.repository');
    const poolGeneration = assistantCachePoolGenerationForTests();
    for (let connection = 0; connection < 3; connection++) {
      let failure: unknown;
      try {
        await findCompletedBriefing(String(connection).repeat(64));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 'CONNECTION_CLOSED' });
      expect(accepted).toHaveLength(connection + 1);
      expect(queryBytes[connection]).toBeGreaterThan(0);
      expect(accepted[connection].destroyed).toBe(true);
      expect(encrypted[connection].destroyed).toBe(true);
      expect(assistantCacheOpenTransportCountForTests()).toBe(0);
      expect(assistantCachePoolGenerationForTests()).toBe(poolGeneration);
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    for (const socket of encrypted) socket.destroy();
    for (const socket of accepted) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve()))
    );
  }
}, 15_000);
