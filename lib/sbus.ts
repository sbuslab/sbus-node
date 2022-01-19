import { ClassConstructor } from 'class-transformer';
import { RabbitMqTransport } from './rabbitmq/rabbitMqTransport';
import Unit from './utils/unit';
import { Context } from './model/context';

export default class Sbus {
  private transport: RabbitMqTransport;

  constructor(transport: RabbitMqTransport) {
    this.transport = transport;
  }

  async request<T extends object>(
    routingKey: string,
    msg: string | object | null = null,
    cls: ClassConstructor<T>,
    context: Context = {},
  ): Promise<T> {
    return this.transport.send<T>(routingKey, msg, cls, context, { hasResponse: true });
  }

  async command(routingKey: string, msg: string | object | null = null, context: Context = {}): Promise<void> {
    return this.transport.send(routingKey, msg, Unit, context).then(() => undefined);
  }

  async event(routingKey: string, msg: string | object | null = null, context: Context = {}): Promise<void> {
    return this.transport.send((routingKey.includes(':') ? '' : 'events:') + routingKey, msg, Unit, context).then(() => undefined);
  }

  async on<T>(routingKey: string, handler: (req: any, ctx: Context) => Promise<T>): Promise<void> {
    return this.transport.subscribe<T>(routingKey, handler);
  }
}
