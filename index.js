"use strict";

var fs                          = require('fs'),
    path                        = require('path'),
    rng                         = require('crypto').rng,
    q                           = require('kew'),
    through                     = require('through'),
    nodeResolve                 = require('resolve'),
    browserResolve              = require('browser-resolve'),
    aggregate                   = require('stream-aggregate-promise'),
    asStream                    = require('as-stream'),
    utils                       = require('lodash'),
    depsTransform               = require('./transforms/deps'),
    jsonTransform               = require('./transforms/json')

module.exports = function(mains, opts) {
  return new Graph(mains, opts).toStream()
}

module.exports.Graph = Graph

function Graph(mains, opts) {
  this.opts = opts || {}
  this.output = through()
  this.output.pause()
  process.nextTick(this.output.resume.bind(this.output))
  this.basedir = this.opts.basedir || process.cwd()
  this.resolveImpl = resolveWith.bind(null, this.opts.resolve || browserResolve)
  this.cache = this.opts.cache || {};
  this.seen = {}
  this.entries = []

  if (mains)
    [].concat(mains).filter(Boolean).forEach(this.addEntry.bind(this))
}

Graph.prototype = {

  resolve: function(id, parent) {
    if (this.opts.filter && !this.opts.filter(id))
      return q.resolve({id: false})

    var relativeTo = {
      packageFilter: this.opts.packageFilter,
      extensions: this.opts.extensions,
      modules: this.opts.modules,
      paths: [],
      filename: parent.id,
      package: parent.package
    }

    return this.resolveImpl(id, relativeTo)
      .then(function(mod) {
        this.cache[mod.id] = utils.assign(this.cache[mod.id] || {}, mod)
        return this.cache[mod.id]
      }.bind(this))
      .fail(function(err) {
        err.message += [', module required from', parent.id].join(' ')
        throw err
      }.bind(this))
  },

  resolveMany: function(ids, parent) {
    var result = {},
        resolutions = q.all(ids.map(function(id) {
          return this.resolve(id, parent).then(function(r) {result[id] = r.id})
        }.bind(this)))
    return resolutions.then(function() { return result })
  },

  addEntry: function(m) {
    var mod = {entry: true, package: undefined}
    if (typeof m.pipe === 'function') {
      mod.id = path.join(this.basedir, rng(8).toString('hex') + '.js')
      mod.sourcePromise = aggregate(m)
    } else {
      mod.id = path.resolve(m)
    }
    this.entries.push(mod)
    return this
  },

  toStream: function() {
    q.all(this.entries
      .map(function(mod) {return this.walk(mod, {id: '/'})}.bind(this)))
      .fail(this.output.emit.bind(this.output, 'error'))
      .fin(this.output.queue.bind(this.output, null))
    return this.output
  },

  walk: function(mod, parent) {
    var modID = mod.id || mod

    if (this.seen[modID]) return
    this.seen[modID] = true

    if (this.cache[modID])
      mod = this.cache[modID]

    if (mod.source) {
      var cached = this.cache[modID]
      this.report(cached)
      return this.walkDeps(cached, parent)
    }

    return this.applyTransforms(mod)
      .then(this.report.bind(this))
      .then(this.walkDeps.bind(this))
  },

  walkDeps: function(mod) {
    if (mod.deps && Object.keys(mod.deps).length > 0)
      return q.all(Object.keys(mod.deps)
        .filter(function(id) { return mod.deps[id] })
        .map(function(id) { return this.walk(mod.deps[id], mod) }.bind(this)))
  },

  report: function(mod) {
    delete mod.sourcePromise

    if (!mod.deps)
      mod.deps = {}

    if (Buffer.isBuffer(mod.source))
      mod.source = mod.source.toString()

    this.output.queue(utils.cloneDeep(mod))
    return mod
  },

  readSource: function(mod) {
    if (mod.source) return q.resolve(mod)
    var promise = mod.sourcePromise || aggregate(fs.createReadStream(mod.id))
    return promise.then(function(source) {
      mod.source = source
      return mod
    })
  },

  applyTransforms: function(mod) {
    var transforms = [],
        isTopLevel = this.entries.some(function (entry) {
      return path.relative(path.dirname(entry.id), mod.id)
        .split('/').indexOf('node_modules') < 0
    })

    if (isTopLevel)
      transforms = transforms.concat(this.opts.transform)

    if (mod.package && this.opts.transformKey)
      transforms = transforms.concat(this.getPackageTransform(mod.package))

    transforms = transforms
      .filter(Boolean)
      .map(loadTransform.bind(null, mod))
      .concat(depsTransform, jsonTransform)

    mod = this.readSource(mod)
    return q.all(transforms).then(function(transforms) {
      transforms.forEach(function(t) {
        mod = mod.then(function(mod) {
          return (t.length === 1) ?
            runStreamingTransform(t, mod) : runTransform(t, mod, this)
        }.bind(this))
      }.bind(this))
      return mod
    }.bind(this))
  },

  getPackageTransform: function(pkg) {
    this.opts.transformKey.forEach(function (k) {
      if (pkg && typeof pkg === 'object') pkg = pkg[k]
    })
    return [].concat(pkg).filter(Boolean)
  },

  noParse: function(id) {
    if (!this.opts.noParse)
      return false
    else if (Array.isArray(this.opts.noParse))
      return this.opts.noParse.indexOf(id) > -1
    else
      return this.opts.noParse(id)
  }
}

function mergeInto(target, source) {
  if (!source) return target
  var result = utils.assign({}, target)
  for (var k in source) {
    var t = result[k], s = source[k]
    if (utils.isArray(t) && utils.isArray(s))
      result[k] = t.concat(s)
    else if (utils.isObject(t) && utils.isObject(s))
      result[k] = mergeInto(t, s)
    else
      result[k] = s
  }
  return result
}

function resolveWith(resolve, id, parent) {
  var p = q.defer()
  resolve(id, parent, function(err, filename, pkg) {
    if (err)
      p.reject(err)
    else
      p.resolve({id: filename, package: pkg})
  })
  return p
}

function runStreamingTransform(transform, mod) {
  return aggregate(asStream(mod.source).pipe(transform(mod.id)))
    .then(function(source) {
      mod.source = source
      return mod
    })
}

function runTransform(transform, mod, graph) {
  return q.resolve(transform(mod, graph)).then(mergeInto.bind(null, mod))
}

var transformResolve = resolveWith.bind(null, nodeResolve)

function loadTransform(mod, transform) {
  if (!utils.isString(transform)) return q.resolve(transform)

  return transformResolve(transform, {basedir: path.dirname(mod.id)})
    .fail(function() {
      return transformResolve(transform, {basedir: process.cwd()})
    })
    .then(function(res) {
      if (!res)
        throw new Error([
          'cannot find transform module ', transform,
          ' while transforming ', mod.id
        ].join(''))
      return require(res.id)
    })
    .fail(function(err) {
      err.message += ' which is required as a transform'
      throw err
    })
}
