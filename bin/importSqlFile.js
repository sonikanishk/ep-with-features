const startTime = Date.now();

require('ep_etherpad-lite/node_modules/npm').load({}, (er, npm) => {
  const fs = require('fs');

  const ueberDB = require('ep_etherpad-lite/node_modules/ueberdb2');
  const settings = require('ep_etherpad-lite/node/utils/Settings');
  const log4js = require('ep_etherpad-lite/node_modules/log4js');

  const dbWrapperSettings = {
    cache: 0,
    writeInterval: 100,
    json: false, // data is already json encoded
  };
  const db = new ueberDB.database(settings.dbType, settings.dbSettings, dbWrapperSettings, log4js.getLogger('ueberDB'));

  const sqlFile = process.argv[2];

  // stop if the settings file is not set
  if (!sqlFile) {
    console.error('Use: node importSqlFile.js $SQLFILE');
    process.exit(1);
  }

  log('initializing db');
  db.init((err) => {
    // there was an error while initializing the database, output it and stop
    if (err) {
      console.error('ERROR: Problem while initializing the database');
      console.error(err.stack ? err.stack : err);
      process.exit(1);
    } else {
      log('done');

      log('open output file...');
      const lines = fs.readFileSync(sqlFile, 'utf8').split('\n');

      const count = lines.length;
      let keyNo = 0;

      process.stdout.write(`Start importing ${count} keys...\n`);
      lines.forEach((l) => {
        if (l.substr(0, 27) == 'REPLACE INTO store VALUES (') {
          const pos = l.indexOf("', '");
          const key = l.substr(28, pos - 28);
          let value = l.substr(pos + 3);
          value = value.substr(0, value.length - 2);
          console.log(`key: ${key} val: ${value}`);
          console.log(`unval: ${unescape(value)}`);
          db.set(key, unescape(value), null);
          keyNo++;
          if (keyNo % 1000 == 0) {
            process.stdout.write(` ${keyNo}/${count}\n`);
          }
        }
      });
      process.stdout.write('\n');
      process.stdout.write('done. waiting for db to finish transaction. depended on dbms this may take some time...\n');

      db.close(() => {
        log(`finished, imported ${keyNo} keys.`);
        process.exit(0);
      });
    }
  });
});

function log(str) {
  console.log(`${(Date.now() - startTime) / 1000}\t${str}`);
}

unescape = function (val) {
  // value is a string
  if (val.substr(0, 1) == "'") {
    val = val.substr(0, val.length - 1).substr(1);

    return val.replace(/\\[0nrbtZ\\'"]/g, (s) => {
      switch (s) {
        case '\\0': return '\0';
        case '\\n': return '\n';
        case '\\r': return '\r';
        case '\\b': return '\b';
        case '\\t': return '\t';
        case '\\Z': return '\x1a';
        default: return s.substr(1);
      }
    });
  }

  // value is a boolean or NULL
  if (val == 'NULL') {
    return null;
  }
  if (val == 'true') {
    return true;
  }
  if (val == 'false') {
    return false;
  }

  // value is a number
  return val;
};
