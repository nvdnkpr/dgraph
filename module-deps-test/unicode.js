var parser = require('../');
var test = require('tap').test;
var fs = require('fs');

var files = {
    main: __dirname + '/files/unicode/main.js',
    foo: __dirname + '/files/unicode/foo.js',
    bar: __dirname + '/files/unicode/bar.js'
};

var sources = Object.keys(files).reduce(function (acc, file) {
    acc[file] = fs.readFileSync(files[file], 'utf8');
    return acc;
}, {});

test('unicode deps', function (t) {
    t.plan(1);
    var p = parser(files.main);
    var rows = [];
    
    p.on('data', function (row) { rows.push(row) });
    p.on('end', function () {
        t.same(rows, [
            {
                id: files.main,
                source: sources.main,
                entry: true,
                package: undefined,
                deps: { './foo': files.foo }
            },
            {
                id: files.foo,
                source: sources.foo,
                package: undefined,
                deps: { './bar': files.bar }
            },
            {
                id: files.bar,
                source: sources.bar,
                package: undefined,
                deps: {}
            }
        ]);
    });
});
