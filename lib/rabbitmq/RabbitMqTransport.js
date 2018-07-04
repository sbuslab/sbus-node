const amqp = require('amqplib');
const cuid = require('cuid');

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
    this.log = config.log || console.info;

    // subscription channel closing callback
    this.channelClosingCallback = config.channelClosingCallback || (() => {});

    // subscription channel sending reply error callback
    this.channelReplyErrorCallback = config.channelReplyErrorCallback;
  }

  _connect() {
    if (this.isRunning) {
      return true;
    }
    // Устанавливаем коннект к Rabbit
    return amqp.connect(this.rabbitmqConnection)
      .then((conn) => {
        this.connection = conn;
        this.isRunning = true;

        // Создаем канал и в нем создаем временную очередь
        return this._channelEstablish(
          this.connection, null, { exclusive: true, autoDelete: true },
          (ch) => { this.channel = ch; },
          () => {},
          (resp) => {
            this.replyToQueue = resp.queue;

            // Подписываемся на временную очередь
            // eslint-disable-next-line consistent-return
            return this.channel.consume(this.replyToQueue, (msg) => {
              if (!msg.properties.correlationId || !this.promiseStorage[msg.properties.correlationId]) {
                return;
              }

              const message = JSON.parse(msg.content.toString());

              this.log(message);

              // eslint-disable-next-line consistent-return
              return Promise.resolve(this.promiseStorage[msg.properties.correlationId].resolve_ex(message)).then((res) => {
                delete this.promiseStorage[msg.properties.correlationId];
                return res;
              });
            }, { noAck: true });
          },
        );
      });
  }

  _channelEstablish(connection, routingKey = null, queryOptions = {}, saveChannel, channelOnError, assertQueueCallback) {
    // Создаем канал
    return connection.createChannel().then((ch) => {
      ch.prefetch(this.channelParams.qos, this.channelParams.global);
      saveChannel(ch);

      // В случае если в канал пришла ошибка от сервера о закрытии, то выполняем channelOnError
      ch.on('error', (err) => {
        channelOnError(err, ch);
        this.channelClosingCallback(err);
        return this._channelEstablish(connection, routingKey, queryOptions, saveChannel, channelOnError, assertQueueCallback);
      });

      // Создаем очередь с routing key и выполняем callback
      return ch.assertQueue(routingKey, queryOptions).then(resp => assertQueueCallback(resp, ch));
    });
  }


  send(routingKey, msg, context = {}, transportOptions = {}) {
    const { hasResponse, isEvent } = { hasResponse: false, isEvent: false, ...transportOptions };

    context = {
      Headers: {},
      ...context,
    };

    const bytes = Buffer.from(JSON.stringify({
      body: msg,
      routingKey,
    }));

    const corrId = context.correlationId ? context.correlationId : cuid();

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
        timestamp: Date.now(),
      },
    };

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

      return promiseTimeout(propsBldr.expiration, this.promiseStorage[corrId]).catch((err) => {
        if (err === PROMISE_TIMEOUT_MESSAGE) {
          throw new Error(`didn't get response for request in ${propsBldr.expiration} ms.`);
        }
        throw new Error(err);
      });
    });
  }

  subscribe(routingKey, handler, context) {
    const exchange = context.exchange ? context.exchange : this.commonExchange.name;
    return this._channelEstablish(this.connection, routingKey, { durable: false }, (ch) => { this.subscribeChannels[ch.ch] = ch; }, (err, ch) => {
      delete this.subscribeChannels(ch.ch);
    }, (resp, ch) => ch.bindQueue(routingKey, exchange, routingKey).then(() =>
      // eslint-disable-next-line consistent-return
      ch.consume(routingKey, (msg) => {
        const originalMsg = msg;

        msg = JSON.parse(msg.content.toString());

        return Promise
          .resolve(msg)
          .then(msg => handler(msg, originalMsg.properties) || (() => ({})))
          .then((res) => {
            if (originalMsg.properties.replyTo) {
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
            if (this.channelReplyErrorCallback) {
              this.this.channelReplyErrorCallback(e);
            } else {
              throw e;
            }
          });
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
