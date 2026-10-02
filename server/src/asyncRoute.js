/**
 * Express 4 does not await route handlers, so a rejected promise inside an
 * `async` handler escapes as an unhandled rejection and kills the process
 * instead of producing a 500 response.
 *
 * `wrapRouter` re-registers the handler methods on a router so every async
 * rejection is forwarded to the error middleware. The handler signature is
 * unchanged, so route code stays exactly as it was.
 */
function wrapRouter(router) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const original = router[method].bind(router);
    router[method] = (...args) => {
      const wrapped = args.map((arg) =>
        typeof arg === 'function' ? wrapHandler(arg) : arg
      );
      return original(...wrapped);
    };
  }
  return router;
}

function wrapHandler(handler) {
  // Anything that already accepts 4 args is error-handling middleware, and
  // middleware that calls next() synchronously must not be wrapped.
  if (handler.length >= 4) return handler;
  return function wrappedRouteHandler(req, res, next) {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { wrapRouter, wrapHandler };
