sbus
=============

Service Bus for NodeJs services with RabbitMQ transport

```ts
import { Builder } from 'builder-pattern';
import { Orders } from 'my_models/orders';
import { Order } from 'my_models/order';
import { GetOrders } from 'my_models/getOrders';

await sbus.on<Orders>("get-orders", async (req: GetOrders, context: Context) => {
    return Builder(Orders)
        .orders([new Order(), new Order()])
        .build();
});

const res = await sbus.request<Orders>("get-orders", Builder(GetOrders)
    .id(123)
    .build());
```
