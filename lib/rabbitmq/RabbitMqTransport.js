const amqp = require('amqplib');
const cuid = require('cuid');
const rTracer = require('cls-rtracer');

const promiseTimeout = require('../utils/promiseTimeout');
const PROMISE_TIMEOUT_MESSAGE = require('../utils/promiseTimeout').timeoutMessage;

class RabbitMqTransport {
  constructor(config) {
    // store whole config
    this.config = config;
    // default waiting response timeout
    this.defaultTimeout = config.defaultTimeout || 5000;
    // establish connection on class instance creation
    this.autoinit = this.config.autoinit;
    // amount of command retries
    this.defaultCommandRetries = config.defaultCommandRetries;
    // channel prefetch param
    this.channelParams = {
      qos: config.prefetchCount,
      global: false,
    };
    // singleton Subscribe
    this.useSingletonSubscribe = config.useSingletonSubscribe;
    // handle errors or not
    this.handleErrors = config.handleErrors !== false;
    // exchange settings
    this.commonExchange = {
      name: config.exchange,
      passive: false,
      exchangeType: 'direct',
    };
    this.eventExchange = {
      name: config.eventExchange,
      passive: false,
      exchangeType: 'topic',
    };
    this.retryExchange = {
      name: config.retryExchange,
      passive: false,
      exchangeType: 'fanout',
    };
    this.exchanges = {};
    this.exchanges[config.exchange] = this.commonExchange;
    this.exchanges[config.eventExchange] = this.eventExchange;
    this.exchanges[config.retryExchange] = this.retryExchange;
    // rabbitMQ connection url
    this.rabbitmqConnection = config.rabbitmqConnection || `amqp://${this.config.host}:${this.config.port}`;
    // running status
    this.isRunning = false;
    // promises storage for requests
    this.promiseStorage = {};
    // subscribed channels
    this.subscribeChannels = {};
    if (this.autoinit) {
      this._connect();
    }

    // logging Rabbit responses function
    this.logger = config.logger || console;
    this.logMethod = (config.logger && config.logger.trace) ? 'trace' : 'info';

    // set logger name
    if (config.logger && config.logger.setName) {
      this.logger.setName('sbus');
    }

    // subscription channel closing callback
    this.channelClosingCallback = config.channelClosingCallback || (() => {});

    // subscription channel sending reply error callback
    this.channelReplyErrorCallback = config.channelReplyErrorCallback || ((err) => ({ status: 500, body: { message: err.stack } }));
  }

  _connect() {
    if (this.isRunning) {
      return true;
    }
    // establish connect to Rabbit
    return amqp.connect(this.rabbitmqConnection)
      .then((conn) => {
        this.connection = conn;
        this.isRunning = true;

        // create channel with temporary queue
        return this._channelEstablish(
          this.connection, null, this.commonExchange, { exclusive: true, autoDelete: true },
          (ch) => { this.channel = ch; },
          () => {},
          (resp) => {
            this.replyToQueue = resp.queue;

            // subscribe to temp queue
            // eslint-disable-next-line consistent-return
            return this.channel.consume(this.replyToQueue, (msg) => {
              const handler = this.promiseStorage[msg.properties.correlationId];

              if (!msg.properties.correlationId || !handler) {
                return;
              }

              let message;
              try {
                message = JSON.parse(msg.content.toString());
              } catch (e) {
                message = msg.content.toString();
              }

              const logMsg = `sbus resp <~~~ ${handler.routingKey}: ${JSON.stringify(message)}`;

              if (this.promiseStorage[msg.properties.correlationId].noLogs !== true) {
                this.logger[this.logMethod](logMsg);
              }

              if ((this.handleErrors && (!message || !message.status || message.status >= 400)) || handler.isRejected) {
                if (this.promiseStorage[msg.properties.correlationId].noLogs === true) {
                  this.logger[this.logMethod](this.promiseStorage[msg.properties.correlationId].logMsg);
                  this.logger[this.logMethod](logMsg);
                }
                const err = handler.isRejected
                  ? { status: 504, error: 'timeout', message: 'promise timeout' }
                  : (message.status ? message : { status: 500, error: 'error', ...message });

                // eslint-disable-next-line consistent-return
                return Promise.resolve(handler.reject_ex(JSON.stringify(err))).then(() => {
                  delete this.promiseStorage[msg.properties.correlationId];
                  return null;
                });
              }

              // eslint-disable-next-line consistent-return
              return Promise.resolve(handler.resolve_ex(message)).then((res) => {
                delete this.promiseStorage[msg.properties.correlationId];
                return res;
              });
            }, { noAck: true });
          },
        );
      });
  }

  _channelEstablish(connection, routingKey = null, exchange = {}, queryOptions = {}, saveChannel, channelOnError, assertQueueCallback) {
    // create channel
    return connection.createChannel().then((ch) => {
      ch.prefetch(this.channelParams.qos, this.channelParams.global);
      saveChannel(ch);

      // handle channel error
      ch.on('error', (err) => {
        channelOnError(err, ch);
        this.channelClosingCallback(err);
        return this._channelEstablish(connection, routingKey, exchange, queryOptions, saveChannel, channelOnError, assertQueueCallback);
      });

      // Создаем очередь с routing key и выполняем callback
      return ch.assertExchange(exchange.name, exchange.exchangeType, { durable: false, passive: exchange.passive })
        .then(() => ch.assertQueue(routingKey, queryOptions).then((resp) => assertQueueCallback(resp, ch)));
    });
  }

  send(routingKey, msg, context = {}, transportOptions = {}) {
    const { hasResponse, isEvent } = { hasResponse: false, isEvent: false, ...transportOptions };
    const logMsg = `sbus ~~~~> ${routingKey}: ${JSON.stringify(msg)}`;

    if (context.noLogs !== true) {
      this.logger[this.logMethod](logMsg);
    }

    context = {
      Headers: {},
      ...context,
    };

    const corrId = rTracer.id() ? rTracer.id() : cuid();

    const propsBldr = {
      deliveryMode: hasResponse ? 1 : 2,
      messageId: context.Headers.ClientMessageId ? context.Headers.ClientMessageId : cuid(),
      expiration: context.timeout ? context.timeout : (hasResponse ? this.defaultTimeout : undefined),
      correlationId: corrId,
      replyTo: hasResponse ? this.replyToQueue : undefined,
      headers: {
        'correlation-id': corrId,
        'retry-max-attempts': context.maxRetries ? context.maxRetries : (hasResponse ? 0 : this.defaultCommandRetries), // commands retriable by default
        'expired-at': context.timeout ? Date.now() + context.timeout : null,
        userAgent: context.Headers.userAgent,
        timestamp: Date.now(),
      },
    };

    if (context.noLogs !== true) {
      this.logger[this.logMethod](logMsg);
    }

    const bytes = Buffer.from(JSON.stringify({
      body: msg,
      routingKey,
    }));

    return Promise.resolve(this.channel.publish(
      isEvent ? this.eventExchange.name : this.commonExchange.name,
      routingKey, bytes,
      propsBldr,
    )).then((res) => {
      if (!hasResponse) {
        return res;
      }

      let _resolve;
      let _reject;

      this.promiseStorage[corrId] = new Promise((resolve, reject) => {
        _resolve = resolve;
        _reject = reject;
      });

      this.promiseStorage[corrId].resolve_ex = (value) => {
        _resolve(value);
      };

      this.promiseStorage[corrId].reject_ex = (value) => {
        _reject(value);
      };

      this.promiseStorage[corrId].routingKey = routingKey;

      this.promiseStorage[corrId].noLogs = context.noLogs;

      this.promiseStorage[corrId].logMsg = logMsg;

      return promiseTimeout(propsBldr.expiration, this.promiseStorage[corrId]).catch((err) => {
        if (err === PROMISE_TIMEOUT_MESSAGE) {
          if (context.noLogs === true) {
            this.logger[this.logMethod](logMsg);
          }
          throw new Error(`didn't get response for request in ${propsBldr.expiration} ms.`);
        }
        throw new Error(err);
      });
    });
  }

  subscribe(routingKey, handler, context) {
    const _this = this;
    this.logger.info(`Subscription inited: ${routingKey}`);
    const exchange = context.exchange && this.exchanges[context.exchange] ? this.exchanges[context.exchange] : this.commonExchange;
    return this._channelEstablish(this.connection, routingKey, exchange, { durable: false }, async (ch) => {
      let promises = [];

      if (this.useSingletonSubscribe) {
        promises = Object.values(this.subscribeChannels)
          .filter((channel) => channel.routingKey === routingKey)
          .map((c) => c.close().then(() => delete this.subscribeChannels[c.ch]));
      }

      this.subscribeChannels[ch.ch] = ch;
      this.subscribeChannels[ch.ch].routingKey = routingKey;

      return Promise.all(promises);
    }, (err, ch) => {
      delete this.subscribeChannels[ch.ch];
    }, (resp, ch) => ch.bindQueue(routingKey, exchange.name, routingKey).then(() =>
      // eslint-disable-next-line consistent-return, implicit-arrow-linebreak
      ch.consume(routingKey, (msg) => {
        const originalMsg = msg;
        return rTracer.runWithId(() => {
          try {
            msg = JSON.parse(msg.content.toString());
          } catch (e) {
            msg = msg.content.toString();
          }
          const logMsg = `sbus <~~~ ${routingKey}: ${JSON.stringify(msg)}`;

          if (context.noLogs !== true) {
            _this.logger[this.logMethod](logMsg);
          }

          let replyError = false;

          return Promise
            .resolve(msg)
            .then((msg) => handler(msg, originalMsg.properties) || (() => ({})))
            .catch((e) => {
              _this.logger.error('Sbus error: ', e);
              if (_this.channelReplyErrorCallback) {
                replyError = true;
                return _this.channelReplyErrorCallback(e);
              }

              throw e;
            })
            .then((res) => {
              if (originalMsg.properties.replyTo) {
                if (context.noLogs === true && replyError) {
                  _this.logger[this.logMethod](logMsg);
                }
                if (context.noLogs !== true || replyError) {
                  _this.logger[this.logMethod](`sbus resp ~~~> ${routingKey}: ${JSON.stringify(res)}`);
                }
                return this.channel.publish(
                  '',
                  originalMsg.properties.replyTo,
                  Buffer.from(JSON.stringify(res)),
                  {
                    correlationId: originalMsg.properties.correlationId,
                    headers: {
                      'correlation-id': originalMsg.properties.headers['correlation-id'],
                    },
                  },
                );
              }
              return true;
            })
            .catch((e) => {
              _this.logger[this.logMethod]('Unhandled error when process message', e);
            });
        }, originalMsg.properties.headers['correlation-id']);
      }, { noAck: true })));
  }

  closeSubscribedChannels() {
    this.promiseStorage = {};
    const promises = [];
    Object.keys(this.subscribeChannels).forEach((channel) => {
      promises.push(this.subscribeChannels[channel].close());
    });
    promises.push(Promise.resolve(this.subscribeChannels = {}));
    return Promise.all(promises);
  }

  closeConnection() {
    return this.channel.close().then(() => this.connection.close());
  }
}

module.exports = RabbitMqTransport;
