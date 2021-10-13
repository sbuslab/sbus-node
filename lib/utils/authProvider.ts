// eslint-disable-next-line max-classes-per-file
import tweetnacl, {SignKeyPair} from 'tweetnacl';
import { Logger } from '../model/logger';
import { Context } from '../model/context';

export interface AuthProvider {
  sign: (context: Context, body: Buffer) => Context;
  verify: (context: Context, body: Buffer) => void;
}

export interface AuthConfig {
  enabled: boolean;
  name?: string;
  privKey?: string;
  publicKeys?: { [key: string]: string }
  access?: { [key: string]: string[] }
  groups?: { [key: string]: string[] }
}

export default class AuthProviderImpl implements AuthProvider {
  private logger: Logger;

  private originName: string;

  private publicKeys: { [p: string]: string };

  private privKey: SignKeyPair;

  private access: { [p: string]: string[] };

  private groups: { [p: string]: string[] };

  constructor(config: AuthConfig, logger: Logger) {
    this.originName = config.name!;
    this.publicKeys = config.publicKeys ?? {};
    this.privKey = tweetnacl.sign.keyPair.fromSeed(Buffer.from(config.privKey!, 'hex'));
    this.access = config.access ?? {};
    this.groups = config.groups ?? {};
    this.logger = logger;
  }

  sign(context: Context, body: Buffer): Context {
    const signature = tweetnacl.sign.detached(body, this.privKey.secretKey);

    context.origin = this.originName;
    context.signature = Buffer.from(signature).toString('base64');

    return context;
  }

  verify(context: Context, body: Buffer): void {
    const caller = context.origin;
    if (caller == null || context.signature == null || this.publicKeys[caller] == null) {
      this.logger.debug(`Unauthenticated sbus request: ${context.routingKey}, caller: ${context.origin}`);
    } else {
      const signature = Buffer.from(context.signature, 'base64');
      const pubKey = this.publicKeys[caller];

      const { routingKey } = context;

      if (tweetnacl.sign.detached.verify(body, signature, Buffer.from(pubKey, 'hex'))) {
        const callerGroups = this.groups[caller] ?? [];

        if (caller === this.originName
          || (this.access['*'] && (this.access['*'].includes('*') || this.access['*'].includes(caller) || this.access['*'].filter((v) => callerGroups.includes(v)).length > 0))
          || (this.access[routingKey!] && (this.access[routingKey!].includes('*') || this.access[routingKey!].includes(caller) || this.access[routingKey!].filter((v) => callerGroups.includes(v)).length > 0))) {
        // ok
        } else {
          this.logger.warn(`Sbus: ${caller} has no access to ${routingKey} method!`);
        }
      } else {
        this.logger.warn(`Incorrect internal request signature: ${caller} → ${routingKey} (${signature})`);
      }
    }
  }
}

export class NoopAuthProvider implements AuthProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sign(context: Context, _body: Buffer) {
    return context;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  verify(_context: Context, _body: Buffer) {

  }
}
