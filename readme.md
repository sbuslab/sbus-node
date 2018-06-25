sbus
=============

Service Bus for nodeJs services with RabbitMQ transport

```js
sbus.on("get-orders", (req, context) => myFunc(req, context));

sbus.request("get-orders", { id: 123 });
}
```
