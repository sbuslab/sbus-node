class Sbus {
  constructor(transport) {
    this.transport = transport;
  }

  request(routingKey, msg = null, context = {}) {
    return this.transport.send(routingKey, msg, context, { hasResponse: true });
  }

  command(routingKey, msg = null, context = {}) {
    return this.transport.send(routingKey, msg, context);
  }

  event(routingKey, msg = null, context = {}) {
    return this.transport.send(routingKey, msg, context, { isEvent: true });
  }

  on(routingKey, handler, context = {}) {
    return this.transport.subscribe(routingKey, handler, context);
  }
}

module.exports = Sbus;
