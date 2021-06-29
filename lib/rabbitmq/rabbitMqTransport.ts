import amqp, { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import rTracer from 'cls-rtracer';
import util from 'util';
import prometheus from 'prom-client';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { validateOrReject } from 'class-validator';
import { classToPlain, plainToClass } from 'class-transformer';
import { ClassType } from 'class-transformer/ClassTransformer';
import { v4 as uuidv4 } from 'uuid';
import { ExternalPromise, PROMISE_TIMEOUT_MESSAGE, promiseTimeout } from '../utils/promiseTimeout';
import {
  errorFromCode, GeneralError, InternalServerError, NotFoundError,
} from '../model/errorMessage';
import Unit from '../utils/unit';

const eventsHeartbeat = new prometheus.Gauge({ name: 'sbus_events_heartbeat', help: 'Sbus events heartbeat', labelNames: ['routingKey'] });
const histogram = new prometheus.Histogram({ name: 'sbus_processing_seconds', help: 'Sbus processing metrics', labelNames: ['type', 'routingKey'] });

interface Logger {
  debug(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
  warn(message?: any, ...optionalParams: any[]): void;
  info(message?: any, ...optionalParams: any[]): void;
  trace(message?: any, ...optionalParams: any[]): void;
  setName?(name: string): void;
  setTrimLength?(trimLength: number): void;
}

interface RpcServer extends ChannelWrapper {
  heartbeatId: NodeJS.Timeout;
  subscriptionName: string
  _channel: ChannelWithId,
  consumerTag: string,
}

interface ChannelWithId extends ConfirmChannel {
  ch: number
}

async function meter<T>(typeName: string, routingKey: string, f: () => Promise<T>): Promise<T> {
  const metric = histogram.labels(typeName, routingKey);
  const timer = metric.startTimer();
  try {
    return await f();
  } finally {
    // @ts-ignore
    metric.observe(timer());
  }
}

export interface Context {
  timeout?: number,
  maxRetries?: number,
  attemptNr?: number,
  correlationId?: string,
  messageId?: string,
  clientMessageId?: string,
  routingKey?: string,
  timestamp?: number,
  ip?: string,
  userAgent?: string,
  expiredAt?: number,
}

interface ChannelOptions {
  exchange: string,
  exchangeType: string,

  queueName?: string,
  durable?: boolean,
  exclusive?: boolean,
  autoDelete?: boolean,
  mandatory?: boolean,
  heartbeat?: boolean,
  routingKeys?: string[], // optional, by default get from subscriptionName
}

interface ChannelConfig {
  name: string,
  producer: amqp.ChannelWrapper;
  exchange: string,
  exchangeType: string,
  retryExchange: string,

  queueNameFormat: string,
  durable: boolean,
  exclusive: boolean,
  autoDelete: boolean,
  mandatory: boolean,
  heartbeat: boolean,
  routingKeys?: string[], // optional, by default get from subscriptionName
}

export interface RabbitConfig {
  host: string;
  username: string;
  password: string;
  port: number;
  prefetchCount: number;
  defaultCommandRetries: number;
  defaultTimeout: number;
  shutdownTimeout: number;
  logTrimLength: number;
  unloggedRequests: string[]
  useSingletonSubscribe: boolean;
  autoinit: boolean;
  logger?: Logger;
  channels: { [key: string]: ChannelOptions }
}

function toNumber(stringNumber?: string): number | undefined {
  if (typeof stringNumber === 'string') {
    return parseInt(stringNumber, 10);
  }

  return stringNumber;
}

export class RabbitMqTransport {
  private defaultTimeout: number;

  private shutdownTimeout: number;

  private logMethod: 'trace' | 'info';

  private unloggedRequests: string[];

  private defaultCommandRetries: number;

  private channelParams: { qos: number; global: boolean };

  private autoinit: boolean;

  private useSingletonSubscribe: boolean;

  private host: string;

  private port: number;

  private username: string;

  private password: string;

  private isRunning: boolean;

  private isInited: boolean;

  private replyToQueue: string;

  private connection: AmqpConnectionManager;

  private rpcClient: RpcServer;

  private logger: Logger;

  private channels: { [key: string]: ChannelOptions };

  private channelConfigs: { [key: string]: ChannelConfig };

  private correlationMap: { [key: string]: ExternalPromise<any> };

  private promiseStorage: { [key: string]: ChannelConfig };

  private rpcServers: { [key: string]: RpcServer };

  private contextStorage: { [key: string]: Context };

  async init(conf: RabbitConfig = {
    host: 'localhost',
    username: 'guest',
    password: 'guest',
    port: 5672,
    prefetchCount: 64,
    defaultCommandRetries: 15,
    defaultTimeout: 12000,
    shutdownTimeout: 3000,
    logTrimLength: 2048,
    unloggedRequests: [],
    useSingletonSubscribe: false,
    autoinit: true,
    channels: {
      default: {
        exchange: 'sbus.common',
        exchangeType: 'direct',

        queueName: '%s',
        durable: false,
        exclusive: false,
        autoDelete: false,
        mandatory: true,
        heartbeat: false,
        routingKeys: [], // optional, by default get from subscriptionName
      },
      events: {
        exchange: 'sbus.events',
        exchangeType: 'topic',

        mandatory: false,
        heartbeat: true,
      },
      broadcast: {
        exchange: 'sbus.events',
        exchangeType: 'topic',

        queueName: '',
        exclusive: true,
        autoDelete: true,
        mandatory: false,
        heartbeat: true,
      },
    },
  }): Promise<void> {
    this.logger = conf.logger || console; // setup logger
    this.logMethod = (conf.logger && conf.logger.trace) ? 'trace' : 'info';

    if (this.logger && this.logger.setName) { // set logger name if applicable
      this.logger.setName('sbus');
    }

    if (this.logger.setTrimLength) {
      this.logger.setTrimLength(conf.logTrimLength);
    }

    this.defaultTimeout = conf.defaultTimeout;
    this.shutdownTimeout = conf.shutdownTimeout;
    this.unloggedRequests = conf.unloggedRequests;
    this.defaultCommandRetries = conf.defaultCommandRetries;
    this.channelParams = {
      qos: conf.prefetchCount,
      global: false,
    };
    this.autoinit = conf.autoinit; // establish connection on class instance creation
    this.useSingletonSubscribe = conf.useSingletonSubscribe; // singleton Subscribe

    this.channels = conf.channels;
    // rabbitMQ connection url
    this.host = conf.host;
    this.port = conf.port;
    this.username = conf.username;
    this.password = conf.password;
    this.isRunning = false; // running status
    this.isInited = false;
    this.promiseStorage = {}; // promises storage for requests
    this.rpcServers = {}; // subscription channels

    this.contextStorage = {}; // storage for subscribe context

    this.channelConfigs = {};

    if (this.autoinit) {
      await this.connect();
    }
  }

  async connect() {
    if (this.isInited) {
      if (this.isRunning) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        const timerId = setInterval(() => {
          if (this.isRunning) {
            clearInterval(timerId);
            resolve(undefined);
          }
        }, 10);
      });
    }

    this.isInited = true;
    this.logger.debug(`Sbus connecting to: ${this.host}`);
    this.connection = await amqp.connect(this.host.split(',')
      .map((host) => `amqp://${this.username}:${this.password}@${host}:${this.port}`),
    {
      reconnectTimeInSeconds: 3,
      heartbeatIntervalInSeconds: 5,
    });

    this.connection.on('disconnect', (err) => {
      this.logger.error('rabbit connection failure', err);
    });

    // eslint-disable-next-line @typescript-eslint/naming-convention
    const _this = this;

    const producer = this.connection.createChannel();
    producer.on('error', (err) => {
      this.logger.error('Some error in producer channel', err);
    });

    await producer.waitForConnect();

    await producer.addSetup(async (channel: ConfirmChannel) => {
      // eslint-disable-next-line no-restricted-syntax
      for (const name of Object.keys(this.channels)) {
        const config = this.channels[name];

        const cfg = { ...this.channels.default, ...config };

        /* eslint-disable no-await-in-loop */
        await channel.assertExchange(cfg.exchange, cfg.exchangeType, { durable: false }); // exchange
        await channel.assertExchange(`${cfg.exchange}-retries`, 'fanout', { durable: false }); // retryExchange

        await channel.assertQueue(`${cfg.exchange}-retries`, { durable: true, arguments: { 'x-dead-letter-exchange': cfg.exchange } });

        await channel.bindQueue(`${cfg.exchange}-retries`, `${cfg.exchange}-retries`, '#');

        /* eslint-enable no-await-in-loop */

        // TODO: remove !
        _this.channelConfigs[name] = {
          name,
          producer,
          exchange: cfg.exchange,
          exchangeType: cfg.exchangeType,
          retryExchange: `${cfg.exchange}-retries`,
          queueNameFormat: cfg.queueName!,
          durable: cfg.durable!,
          exclusive: cfg.exclusive!,
          autoDelete: cfg.autoDelete!,
          mandatory: cfg.mandatory!,
          heartbeat: cfg.heartbeat!,
          routingKeys: (cfg.routingKeys && cfg.routingKeys.length > 1) ? cfg.routingKeys : undefined,
        };
      }
    });

    this.correlationMap = {}; // correlation map for rpcClient
    this.rpcClient = this.connection.createChannel() as RpcServer;
    this.rpcClient.on('error', (err) => {
      this.logger.error('Some error in rpc client channel', err);
    });
    await this.rpcClient.waitForConnect();

    await this.rpcClient.addSetup(async (channel: ConfirmChannel) => {
      await channel.prefetch(this.channelParams.qos, this.channelParams.global);
      const tempQueue = await channel.assertQueue('', { exclusive: true, autoDelete: true });

      _this.replyToQueue = tempQueue.queue;

      await channel.on('return', async (msg) => {
        const handler = _this.correlationMap[msg.properties.correlationId];

        if (handler) {
          await handler.reject_ex(msg);
          delete _this.promiseStorage[msg.properties.correlationId];
        } else {
          _this.logger.warn(`unhandled message ${util.inspect(msg, { depth: 1, compact: true, breakLength: Infinity })}`);
        }
      });

      await channel.consume(_this.replyToQueue, async (msg: ConsumeMessage | null) => {
        if (msg == null) {
          _this.logger.warn('receive null message in rpcClient channel');
          return;
        }

        const handler = _this.correlationMap[msg.properties.correlationId];

        if (!msg.properties.correlationId || !handler) {
          _this.logger.warn(`unexpected message with correlation id ${msg.properties.correlationId}`);
          return;
        }

        await Promise.resolve(handler.resolve_ex(msg.content));
        delete _this.promiseStorage[msg.properties.correlationId];
      }, { noAck: true });
    });

    process.on('SIGTERM', async () => {
      this.logger.info('Stopping Sbus...');

      // eslint-disable-next-line no-restricted-syntax
      for (const rpcServer of Object.values(this.rpcServers)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await rpcServer._channel.cancel(rpcServer.consumerTag);
          // eslint-disable-next-line no-empty
        } catch (e) { }
      }

      setTimeout(() => {
        this.logger.info('Sbus terminated');

        process.exit();
      }, this.shutdownTimeout);
    });

    this.isRunning = true;

    // eslint-disable-next-line consistent-return,no-useless-return
    return;
  }

  async send<T>(
    routingKey: string,
    msg: string | object | null,
    cls: ClassType<T>,
    context: Context = {},
    transportOptions: { hasResponse?: boolean } = {},
  ): Promise<T> {
    const channel = this.getChannel(routingKey);
    const realRoutingKey = routingKey.split(':').pop();

    if (typeof realRoutingKey === 'undefined') {
      throw new Error('invalid routing key');
    }

    const bytes = Buffer.from(JSON.stringify({
      body: msg,
      routingKey,
    }, null, 2));

    // @ts-ignore
    const contextIds: { correlationId: string, messageId: string } | undefined = rTracer.id();
    const correlationId = uuidv4(); // id for matching request/response
    const corrId = context.correlationId ? context.correlationId : (contextIds?.correlationId ?? uuidv4()); // traceId
    const storedContext = contextIds ? this.contextStorage[contextIds?.messageId!] : undefined;

    const ctx = {
      ...storedContext,
      ...context,
    };

    const { hasResponse } = { hasResponse: false, ...transportOptions };
    const propsBldr = {
      deliveryMode: hasResponse ? 1 : 2, // 2 → persistent
      messageId: ctx.clientMessageId ? ctx.clientMessageId : uuidv4(),
      expiration: ctx.timeout ? Math.max(ctx.timeout ?? 0, 1).toString(10) : (hasResponse ? this.defaultTimeout.toString(10) : undefined),
      correlationId,
      replyTo: hasResponse ? this.replyToQueue : undefined,
      headers: {
        'correlation-id': corrId,
        'routing-key': realRoutingKey,
        'retry-max-attempts': ctx.maxRetries?.toString(10) ?? (hasResponse ? 0 : this.defaultCommandRetries.toString(10)), // commands retryable by default
        'expired-at': ctx.timeout ? (Date.now() + (ctx.timeout ?? 0)).toString(10) : null,
        timestamp: Date.now().toString(10),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      mandatory: channel.mandatory,
    };

    if (corrId !== 'sbus:ping') {
      this.logs('~~~>', realRoutingKey, bytes);
    }

    await this.rpcClient._channel.publish(channel.exchange, realRoutingKey, bytes, propsBldr);

    if (!hasResponse) {
      return plainToClass(cls, {});
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    let _resolve: { (arg0: any): void; (value: any): void; };
    // eslint-disable-next-line @typescript-eslint/naming-convention
    let _reject: { (arg0: any): void; (reason?: any): void; };

    this.correlationMap[correlationId] = new ExternalPromise((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
    });

    this.correlationMap[correlationId].resolve_ex = (value) => {
      _resolve(value);
    };

    this.correlationMap[correlationId].reject_ex = (value) => {
      _reject(value);
    };

    this.correlationMap[correlationId].routingKey = routingKey;

    return await meter<T>('request', realRoutingKey, async () => {
      let response;
      try {
        response = await promiseTimeout(parseInt(propsBldr.expiration ?? '0', 10), this.correlationMap[correlationId]);
      } catch (err) {
        if (err === PROMISE_TIMEOUT_MESSAGE) {
          this.logs('timeout error', realRoutingKey, bytes, err);

          throw new GeneralError(504, 'GatewayError', `Timeout on ${realRoutingKey} with message ${bytes.toString()}`);
        }

        this.logs('error', realRoutingKey, bytes, err);
        throw new InternalServerError(`Unexpected response for \`${realRoutingKey}\``);
      }

      this.logs('resp <~~~', realRoutingKey, response);

      const parsed = JSON.parse(response.toString());

      if (parsed.status < 400) {
        const deserialized = plainToClass(cls, parsed.body);

        await validateOrReject(deserialized);
        return deserialized;
      }

      throw errorFromCode(parsed.status, parsed.body);
    });
  }

  async subscribe<T>(routingKey: string, handler: (req: any, ctx: Context) => Promise<T>): Promise<void> {
    const channel = this.getChannel(routingKey);
    const subscriptionName = routingKey.split(':').pop();

    if (typeof subscriptionName === 'undefined') {
      throw new Error('invalid routing key');
    }

    // eslint-disable-next-line @typescript-eslint/naming-convention
    const _this = this;

    const rpcServer = this.connection.createChannel() as RpcServer;
    await rpcServer.waitForConnect();

    rpcServer._channel.on('error', (err) => {
      this.logger.error(`Some error in rpcServer channel for ${routingKey}`, err);
    });

    if (this.useSingletonSubscribe) { // clean all prev subscriptions if we use singleton subscribe
      await Promise.all(Object.entries(_this.rpcServers)
        .filter(([, rpc]) => rpc.subscriptionName === subscriptionName)
        .map(([id, rpc]) => rpc.close().then(() => delete this.rpcServers[id])));
    }

    rpcServer.subscriptionName = subscriptionName;
    this.rpcServers[rpcServer._channel.ch] = rpcServer;

    // @ts-ignore
    await rpcServer.addSetup(async (ch: ChannelWithId) => {
      await ch.prefetch(this.channelParams.qos, this.channelParams.global);

      const queue = await ch.assertQueue(channel.queueNameFormat.replace('%s', subscriptionName), {
        durable: channel.durable,
        exclusive: channel.exclusive,
        autoDelete: channel.autoDelete,
      });

      // eslint-disable-next-line no-restricted-syntax
      // eslint-disable-next-line no-restricted-syntax
      for (const rt of [...new Set((channel.routingKeys ?? [subscriptionName])
        // add routingKey with channel prefix for handling retried messages
        .flatMap((rtKey) => [rtKey, channel.queueNameFormat.replace('%s', rtKey)])
        .filter((rtKey) => rtKey !== ''))]) {
        // eslint-disable-next-line no-await-in-loop
        await ch.bindQueue(queue.queue, channel.exchange, rt);
      }

      const consumer = await ch.consume(queue.queue, (msg: ConsumeMessage | null) => {
        if (msg == null) { // in this case somebody delete queue, we should setup subscription again
          _this.logger.error(`Seems somebody delete ${subscriptionName} queue. Try to re-subscribe...`);
          return _this.subscribe(routingKey, handler);
        }

        return rTracer.runWithId(async () => {
          await meter('handle', subscriptionName, async () => {
            const correlationId = msg.properties.headers['correlation-id'];

            let payload;
            try {
              payload = JSON.parse(msg.content.toString()).body;
            } catch (e) {
              payload = msg.content.toString();
            }

            if (correlationId === 'sbus:ping') {
              const pingAt = payload.ping || 0;
              eventsHeartbeat.labels(routingKey).set(Date.now() - pingAt);
              return;
            }

            _this.logs('<~~~', subscriptionName, msg.content);

            const context = {
              timeout: toNumber(msg.properties.headers.timeout),
              maxRetries: toNumber(msg.properties.headers['retry-max-attempts']),
              attemptNr: toNumber(msg.properties.headers['retry-attempt-nr']),
              correlationId: msg.properties.headers['correlation-id'],
              messageId: msg.properties.messageId,
              routingKey: msg.properties.headers['routing-key'] || msg.fields.routingKey,
              timestamp: toNumber(msg.properties.headers.timestamp),
              ip: msg.properties.headers.ip,
              userAgent: msg.properties.headers.userAgent,
              expiredAt: toNumber(msg.properties.headers['expired-at']),
            };

            if (context.expiredAt) {
              context.timeout = Math.max(1, context.expiredAt - Date.now());
            }

            _this.contextStorage[context.messageId] = context;

            try {
              try {
                const res = await Promise.resolve(handler(payload, context));
                const bytes = Buffer.from(JSON.stringify({ status: '200', body: classToPlain(res) }, null, 2));

                if (msg.properties.replyTo) {
                  _this.logs('resp ~~~>', subscriptionName, bytes);
                  await channel.producer.publish(
                    '',
                    msg.properties.replyTo,
                    bytes,
                    {
                      correlationId: msg.properties.correlationId,
                      headers: {
                        'correlation-id': msg.properties.headers['correlation-id'],
                      },
                    },
                  );
                }
                return;
              } catch (e) {
                if (!(e instanceof GeneralError) || e.unrecoverable) {
                  const heads = msg.properties.headers;
                  const attemptsMax = heads['retry-max-attempts'];
                  const attemptNr = heads['retry-attempt-nr'] || 1;
                  const originRoutingKey = heads['routing-key'] || msg.fields.routingKey;

                  if (attemptsMax && attemptsMax >= attemptNr + 1) {
                    heads['retry-attempt-nr'] = attemptNr + 1;

                    const backoff = Math.round(2 ** Math.min(attemptNr - 1, 6)) * 1000; // max 64 seconds

                    const updProps = {
                      headers: heads,
                      expiration: backoff, // millis, exponential backoff
                      mandatory: false,
                    };

                    // if message will be expired before next attempt — skip it
                    if (!e.unrecoverable && heads['expired-at'] && heads['expired-at'] <= Date.now() + backoff) {
                      this.logs('timeout', originRoutingKey, Buffer.from(`Message will be expired at ${heads['expired-at']}, don't retry it!`), e);
                      throw e;
                    } else {
                      this.logs('error', originRoutingKey, Buffer.from(`${e.message}. Retry attempt ${attemptNr} after ${backoff} millis...`), e);
                      try {
                        // eslint-disable-next-line max-len
                        await channel.producer.publish(channel.retryExchange, channel.queueNameFormat.replace('%s', originRoutingKey), msg.content, updProps);
                      } catch (error) {
                        throw new InternalServerError(`Error on publish retry message for ${originRoutingKey}: ${error}`);
                      }
                    }
                  } else {
                    throw e;
                  }
                } else {
                  throw e;
                }
              }
            } catch (e) {
              _this.logs('error', subscriptionName, Buffer.from(e.message), e);

              if (msg.properties.replyTo != null) {
                let response;
                if (e instanceof GeneralError) {
                  response = { status: e.code.toString(), body: { message: e.message, error: e.error } };
                } else {
                  response = { status: '500', body: { message: e.message } };
                }
                const bytes = Buffer.from(JSON.stringify(response, null, 2));

                _this.logs('resp ~~~>', subscriptionName, bytes);

                await channel.producer.publish(
                  '',
                  msg.properties.replyTo,
                  bytes,
                  {
                    correlationId: msg.properties.correlationId,
                    headers: {
                      'correlation-id': msg.properties.headers['correlation-id'],
                    },
                  },
                );
              }
            }
            delete _this.contextStorage[context.messageId];
          });
        }, { messageId: msg.properties.messageId, correlationId: msg.properties.headers['correlation-id'] });
      }, { noAck: true });

      _this.rpcServers[ch.ch].consumerTag = consumer.consumerTag;

      _this.logger.debug(`Sbus subscribed to: ${subscriptionName} / ${util.inspect(channel, { depth: 0, breakLength: Infinity })}`);
    });

    if (channel.heartbeat) {
      this.rpcServers[rpcServer._channel.ch].heartbeatId = setInterval(async () => {
        try {
          await this.send(routingKey, {
            ping: Date.now(),
          }, Unit, { correlationId: 'sbus:ping' });
          // eslint-disable-next-line no-empty
        } catch (e) {}
      }, 60000);
    }
  }

  private getChannel(routingKey: string) {
    if (routingKey.includes(':')) {
      const channel = this.channelConfigs[routingKey.split(':')[0]];

      if (typeof channel === 'undefined') {
        throw new InternalServerError(`There is no channel configuration for Sbus routingKey = ${routingKey}!`);
      }

      return channel;
    }

    return this.channelConfigs.default;
  }

  private logs(prefix: string, routingKey: string, body: Buffer, e?: Error): void {
    if (e != null || !this.unloggedRequests.includes(routingKey)) {
      const msg = `sbus ${prefix} ${routingKey}: ${body.toString()}`;

      if (e == null) {
        this.logger[this.logMethod](msg);
      } else if (e instanceof NotFoundError) {
        this.logger.debug(msg);
      } else if (e instanceof GeneralError && e.unrecoverable) {
        this.logger.warn(msg, e);
      } else this.logger.error(msg, e);
    }
  }
}
