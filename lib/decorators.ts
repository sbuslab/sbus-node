import 'reflect-metadata';
import { plainToClass } from 'class-transformer';
import { validateOrReject } from 'class-validator';
import { BadRequestError } from './model/errorMessage';

const INITED_SUBSCRIPTIONS = new Map<string, any[]>();

type InitMethodDescriptor = TypedPropertyDescriptor<() => any>
| TypedPropertyDescriptor<(...args: any) => Promise<any>>;

// decorator for sbus subscriptions that transform message to class instance and validate it using class-validator
export function subscribe(routingKey: string) {
  // eslint-disable-next-line func-names
  return function (target: any, propertyKey: string, descriptor: InitMethodDescriptor) {
    const types = Reflect.getMetadata('design:paramtypes', target, propertyKey);
    if (typeof descriptor.value !== 'undefined' && types.length !== 0) {
      const original = descriptor.value;
      // eslint-disable-next-line func-names
      descriptor.value = async function (...args: any[]) {
        const transformedArgs = args.map((arg, index) => plainToClass(types[index], arg));

        const promises: any[] = [];

        transformedArgs.forEach((arg: any) => {
          if (arg != null && !['string', 'number'].includes(typeof arg) && arg.constructor != null) {
            promises.push(validateOrReject(arg));
          }
        });

        try {
          await Promise.all(promises);
        } catch (e) {
          throw new BadRequestError({ message: e[0].toString(), error: 'validation-error' });
        }

        return original.bind(this)(...transformedArgs);
      };
    }
    if (!INITED_SUBSCRIPTIONS.has(target.constructor.name)) {
      INITED_SUBSCRIPTIONS.set(target.constructor.name, []);
    }
    INITED_SUBSCRIPTIONS.get(target.constructor.name)!.push({ routingKey, handler: descriptor, schedulePeriod: target.schedulePeriod });
  };
}

export function schedule(period: number) {
  // @ts-ignore
  // eslint-disable-next-line func-names,@typescript-eslint/no-unused-vars
  return function (target: any, propertyKey: string, descriptor: InitMethodDescriptor) {
    target.schedulePeriod = period;
  };
}

// decorator to enable all subscriptions that are presented in class
export function autoSubscribe(target: any) {
  // save a reference to the original constructor
  const original = target;

  // the new constructor behaviour
  // eslint-disable-next-line func-names
  const f : any = async function (...args: any[]) {
    // eslint-disable-next-line new-cap
    const inited = await new original(...args); // here constructor is with await for cases of other async decorators

    // @ts-ignore
    // eslint-disable-next-line no-proto
    const subscriptions = INITED_SUBSCRIPTIONS.get(target.prototype.__proto__.constructor.name);

    if (typeof subscriptions !== 'undefined') {
      // eslint-disable-next-line no-restricted-syntax
      for (const subscription of subscriptions) {
        // eslint-disable-next-line no-await-in-loop
        await inited.sbus.on(subscription.routingKey, subscription.handler.value.bind(inited));
        if (subscription.schedulePeriod) {
          // eslint-disable-next-line no-await-in-loop
          await inited.sbus.command('scheduler.schedule', {
            period: subscription.schedulePeriod,
            routingKey: subscription.routingKey,
          });
        }
      }
    }
  };

  // copy prototype so intanceof operator still works
  f.prototype = original.prototype;

  // return new constructor (will override original)
  return f;
}
