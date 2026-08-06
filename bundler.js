'use strict';

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const terser = require('terser');

const config = {
  compact: false,
  plugins: [
    ['@babel/plugin-transform-typescript', {'isTSX': true}],
    ['@babel/plugin-proposal-class-properties', {'loose': true}],
    ['@babel/plugin-proposal-optional-chaining', {'loose': true}],
    ['@babel/plugin-proposal-object-rest-spread', {'loose': true, 'useBuiltIns': true}],
    '@babel/plugin-proposal-optional-catch-binding',
    '@babel/plugin-transform-arrow-functions',
    ['@babel/plugin-transform-block-scoping', {'throwIfClosureRequired': false}],
    ['@babel/plugin-transform-classes', {'loose': true}],
    ['@babel/plugin-transform-computed-properties', {'loose': true}],
    ['@babel/plugin-transform-destructuring', {'loose': true, 'useBuiltIns': true}],
    ['@babel/plugin-transform-for-of', {'assumeArray': true}],
    '@babel/plugin-transform-literals',
    '@babel/plugin-transform-parameters',
    '@babel/plugin-transform-shorthand-properties',
    ['@babel/plugin-transform-spread', {'loose': true}],
    ['@babel/plugin-transform-template-literals', {'loose': true}],
    '@babel/plugin-transform-member-expression-literals',
    '@babel/plugin-transform-property-literals'
  ],
}

class Bundler {
  constructor(dirname) {
    this.built = path.resolve(dirname, 'dist');
  }

  read(f, b = 0, e = 0) {
    try {
      const data = fs.readFileSync(path.join(this.built, f), 'utf8');
      if (e) return data.split('\n').slice(b, -e).join('\n') + '\n';
      if (b) return data.split('\n').slice(b).join('\n') + '\n';
      return data + '\n';
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`Missing file 'dist/${f}' - did you run \`npm run compile\`?`);
        process.exit(1);
      }
      throw err;
    }
  }

  // TypeScript 7 no longer emits the legacy ES3 helper layout that the
  // original bundle script spliced by line number. Keep each CommonJS module
  // isolated instead, remove only its loader boilerplate, and bind imports to
  // the shared export object.
  readModule(f, imports = []) {
    try {
      const lines = fs.readFileSync(path.join(this.built, f), 'utf8').split('\n');
      const body = lines.filter(line =>
        line !== '"use strict";' &&
        !line.startsWith('Object.defineProperty(exports,') &&
        !/^(const|let|var) .* = require\(/.test(line) &&
        !line.startsWith('//# sourceMappingURL=')
      );
      const aliases = imports.map(name => `  const ${name} = exports;`).join('\n');
      return `\n{\n${aliases}${aliases ? '\n' : ''}${body.join('\n')}\n}\n`;
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`Missing file 'dist/${f}' - did you run \`npm run compile\`?`);
        process.exit(1);
      }
      throw err;
    }
  }

  async bundle(bundled, output = 'production.min.js') {
    bundled = babel.transformSync(bundled, config).code;
    bundled = (await terser.minify(bundled)).code;
    fs.writeFileSync(path.join(this.built, output), bundled);
  }
}

module.exports = Bundler;
