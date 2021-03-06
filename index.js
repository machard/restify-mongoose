'use strict';
var async = require('async');
var restify = require('restify');
var util = require('util');
var url = require('url');
var EventEmitter = require('events').EventEmitter;

var restifyError = function(err) {
  if ('ValidationError' !== err.name) {
    return err;
  }

  return new restify.InvalidContentError({ body : {
    message : 'Validation failed',
    errors : err.errors
  }});
};

var emitEvent = function(self, event) {
  return function(model, cb) {
    self.emit(event, model);

    if (cb) {
      cb(undefined, model);
    }
  }
};

var sendData = function(res) {
  return function(model, cb) {
    res.send(model);
    cb(undefined, model);
  }
};

var execQuery = function(query) {
  return function(cb) {
    query.exec(cb);
  }
};

var execBeforeSaves = function(req, model, beforeSaves) {
  return function(cb) {
    async.mapSeries(beforeSaves, function(beforeSave, callback) {
      return beforeSave(req, model, callback);
    }, function(err) {
      return cb(err);
    });
  };
};

var execSave = function (model) {
  return function(cb) {
    model.save(function(err, model) {
      if (err)
        return cb(restifyError(err));
      else
        cb(null, model);
    });
  };
};

var setLocationHeader = function (req, res) {
  return function(model, cb) {
    res.header('Location', req.url + '/' + model._id);
    cb(null, model);
  };
};

var buildProjections = function(req, projection) {
  return function(models, cb) {
    var iterator = function (model, cb) {
      projection(req, model, cb);
    };

    async.map(models, iterator, cb);
  }
};

var buildProjection = function(req, projection) {
  return function(model, cb) {
    if (!model) {
      return cb(new restify.ResourceNotFoundError(req.params.id));
    }

    projection(req, model, cb);
  }
};

var applyPageLinks = function (req, res, page, pageSize, baseUrl) {
  function makeLink(page, rel) {
    var path = url.parse(req.url, true);
    path.query.p = page;
    delete path.search; // required for url.format to re-generate querystring
    var href = baseUrl + url.format(path);
    return util.format('<%s>; rel="%s"', href, rel);
  }

  return function applyPageLinksInner(models, cb) {
    var link = makeLink(0, 'first');

    if (page > 0) {
      link += ', ' + makeLink(page - 1, 'prev');
    }

    var moreResults = models.length > pageSize;
    if (moreResults) {
      models.pop();

      link += ', ' + makeLink(page + 1, 'next');
    }

    res.setHeader('link', link);

    cb(null, models);
  };
}


var Resource = function (Model, options) {
  EventEmitter.call(this);
  this.Model = Model;

  this.options = options || {};
  this.options.pageSize = this.options.pageSize || 100;
  this.options.baseUrl = this.options.baseUrl || '';
  this.options.listProjection = this.options.listProjection || function (req, item, cb) {
    cb(null, item);
  };
  this.options.detailProjection = this.options.detailProjection || function (req, item, cb) {
    cb(null, item);
  };
  this.options.updateProjection = this.options.updateProjection || function (req, item, cb) {
    cb(null, item);
  };
  this.options.insertProjection = this.options.insertProjection || function (req, item, cb) {
    cb(null, item);
  };
};

util.inherits(Resource, EventEmitter);

Resource.prototype.query = function (options) {
  var self = this;

  options = options || {};
  options.pageSize = options.pageSize || this.options.pageSize;
  options.baseUrl = options.baseUrl || this.options.baseUrl;
  options.projection = options.projection || this.options.listProjection;

  return function (req, res, next) {
    var query = self.Model.find({});

    if (req.query.q) {
      try {
        var q = JSON.parse(req.query.q);
        query = query.where(q);
      } catch (err) {
        return res.send(400, { message: 'Query is not a valid JSON object', errors: err });
      }
    }

    if (options.populates) {
      for (var path in options.populates) {
        query = query.populate(
          path,
          options.populates[path].select,
          options.populates[path].model,
          options.populates[path].match
        );
      }
    }

    if (req.query.sort) {
      query = query.sort(req.query.sort);
    }

    if (req.query.select) {
      query = query.select(req.query.select);
    }

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    var page = Number(req.query.p) >= 0 ? Number(req.query.p) : 0;
    query.skip(options.pageSize * page);
    query.limit(options.pageSize + 1);

    async.waterfall([
      execQuery(query),
      applyPageLinks(req, res, page, options.pageSize, options.baseUrl),
      buildProjections(req, options.projection),
      emitEvent(self, 'query'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.detail = function (options) {
  var self = this;

  options = options || {};
  options.projection = options.projection || this.options.detailProjection;
  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    if (options.populates) {
      for (var path in options.populates) {
        query = query.populate(
          path,
          options.populates[path].select,
          options.populates[path].model,
          options.populates[path].match
        );
      }
    }

    if (req.query.select) {
      query = query.select(req.query.select);
    }

    async.waterfall([
      execQuery(query),
      buildProjection(req, options.projection),
      emitEvent(self, 'detail'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.insert = function (options) {
  var self = this;

  options = options || {};

  var beforeSaves = [];
  if (this.options.beforeSave) {
    beforeSaves.push(this.options.beforeSave);
  }
  if (options.beforeSave) {
    beforeSaves.push(options.beforeSave);
  }

  options.projection = options.projection || this.options.insertProjection;

  return function(req, res, next) {
    var model = new self.Model(req.body);
    async.waterfall([
      execBeforeSaves(req, model, beforeSaves),
      execSave(model),
      setLocationHeader(req, res),
      buildProjection(req, options.projection),
      emitEvent(self, 'insert'),
      sendData(res)
    ], next);
  };
};

Resource.prototype.update = function (options) {
  var self = this;

  options = options || {};
  
  var beforeSaves = [];
  if (this.options.beforeSave) {
    beforeSaves.push(this.options.beforeSave);
  }
  if (options.beforeSave) {
    beforeSaves.push(options.beforeSave);
  }

  options.projection = options.projection || this.options.updateProjection;

  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    query.exec(function (err, model) {
      if (err) {
        return next(err);
      }

      if (!model) {
        return next(new restify.ResourceNotFoundError(req.params.id));
      }

      if (!req.body) {
        return next(new restify.InvalidContentError('No update data sent'));
      }

      model.set(req.body);
      
      async.waterfall([
        execBeforeSaves(req, model, beforeSaves),
        execSave(model),
        setLocationHeader(req, res),
        buildProjection(req, options.projection),
        emitEvent(self, 'update'),
        sendData(res)
      ], next);
    });
  };
};

Resource.prototype.remove = function () {
  var self = this;
  var emitRemove = emitEvent(self, 'remove');

  return function (req, res, next) {
    var query = self.Model.findOne({ _id: req.params.id});

    if (self.options.filter) {
      query = query.where(self.options.filter(req, res));
    }

    query.exec(function (err, model) {
      if (err) {
        return next(err);
      }

      if (!model) {
        return next(new restify.ResourceNotFoundError(req.params.id));
      }

      model.remove(function (err) {
        if (err) {
          return next(err);
        }

        res.send(200, model);
        emitRemove(model, next);
      });
    });
  };
};

Resource.prototype.serve = function (path, server, options) {

  options = options || {};

  var handlerChain = function handlerChain(handler, before, after) {
    var handlers = [];

    if (before) {
      handlers = handlers.concat(before);
    }

    handlers.push(handler);

    if (after) {
      handlers = handlers.concat(after);
    }

    return handlers;
  };

  var closedPath = path[path.length - 1] === '/' ? path : path + '/';

  server.get(
    path, 
    handlerChain(this.query(), options.before, options.after)
  );
  server.get(
    closedPath + ':id', 
    handlerChain(this.detail(), options.before, options.after)
  );
  server.post(
    path, 
    handlerChain(this.insert(), options.before, options.after)
  );
  server.del(
    closedPath + ':id', 
    handlerChain(this.remove(), options.before, options.after)
  );
  server.patch(
    closedPath + ':id', 
    handlerChain(this.update(), options.before, options.after)
  );
};

module.exports = function (Model, options) {
  if (!Model) {
    throw new Error('Model argument is required');
  }

  return new Resource(Model, options);
};
