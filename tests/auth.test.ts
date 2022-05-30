import tweetnacl from 'tweetnacl';
import * as crypto from 'crypto';
import { RabbitConfig, RabbitMqTransport } from '../lib/rabbitmq/rabbitMqTransport';
import Sbus from '../lib/sbus';

const configCommon: RabbitConfig = {
  auth: {
    enabled: false,
  },
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
};
const keySender = crypto.randomBytes(32);
const publicKeySender = tweetnacl.sign.keyPair.fromSeed(keySender);
const keyReciever = crypto.randomBytes(32);
const publicKeyReceiver = tweetnacl.sign.keyPair.fromSeed(keyReciever);
const configSender = {
  ...configCommon,
  auth: {
    enabled: true,
    name: 'sender',
    privKey: keySender.toString('hex'),
    publicKeys: {
      sender: Buffer.from(publicKeySender.publicKey).toString('hex'),
    },
  },
};
const configReceiver = {
  ...configCommon,
  auth: {
    enabled: true,
    name: 'receiver',
    privKey: keyReciever.toString('hex'),
    publicKeys: {
      receiver: Buffer.from(publicKeyReceiver.publicKey).toString('hex'),
      sender: Buffer.from(publicKeySender.publicKey).toString('hex'),
    },
    access: {
      '*': ['*'],
    },
  },
};
const transportSender = new RabbitMqTransport();
transportSender.init(configSender);
const sbusSender = new Sbus(transportSender);
const transportReceiver = new RabbitMqTransport();
transportReceiver.init(configReceiver);
const sbusReceiver = new Sbus(transportReceiver);

beforeAll(async () => {
  await transportSender.connect();
  await transportReceiver.connect();
});

afterAll(async () => {
  // @ts-ignore
  await transportSender.connection.close();
  // @ts-ignore
  await transportReceiver.connection.close();
});

test('should auth user', async () => {
  await sbusReceiver.on('check', () => Promise.resolve({
    foo: 'ok',
  }));

  const res = await sbusSender.request('check', {
    foo: 'bar',
  }, Object);

  expect(res).toStrictEqual({ foo: 'ok' });
});

test('should send event', async () => {
  await sbusReceiver.on('events:test-event', () => Promise.resolve({
    foo: 'ok',
  }));

  await sbusSender.event('test-event', {
    foo: 'bar',
  });
});
