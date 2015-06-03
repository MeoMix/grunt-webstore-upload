'use strict';

// MIT License.

module.exports = function(grunt) {
  var Q = require('q'),
      https = require('https'),
      path = require('path'),
      url = require('url'),
      fs = require('fs'),
      http = require('http'),
      util = require('util'),
      open = require('open'),
      readline = require('readline');

  var isWin = /^win/.test(process.platform);
  var isLinux = /^linux$/.test(process.platform);

  // Please see the Grunt documentation for more information regarding task
  // creation: http://gruntjs.com/creating-tasks
  grunt.registerTask('webstore_upload', 'Automate uploading uploading process of the new versions of Chrome Extension to Chrome Webstore', function(taskName) {
    var _task = this;
    var _ = require('lodash');
    var extensionsConfigPath = _task.name + '.extensions';
    var accountsConfigPath = _task.name + '.accounts';
    var accounts;
    var extensions;

    grunt.config.requires(extensionsConfigPath);
    grunt.config.requires(accountsConfigPath);

    extensions = grunt.config(extensionsConfigPath);
    accounts = grunt.config(accountsConfigPath);

    _.each(accounts, function(account, accountName) {
      if (!account.client_id && !account.client_secret) {
        var privateData = getPrivateDataByAccountName(accountName);
        account.client_id = privateData.client_id;
        account.client_secret = privateData.client_secret;
      }
    });

    grunt.registerTask('get_account_token', 'Get token for account', function(accountName) {
      //prepare account for inner function
      var account = accounts[accountName];
      account['name'] = accountName;

      var done = this.async();
      var getTokenFn = account['cli_auth'] ? getTokenForAccountCli : getTokenForAccount;

      getTokenFn(account, function(error, token) {
        if (error !== null) {
          console.log('Error');
          throw error;
        }
        //set token for provided account
        accounts[accountName].token = token;
        done();
      });
    });

    grunt.registerTask('refresh_account_token', 'Refresh token for account', function(accountName) {
      //prepare account for inner function
      var account = accounts[accountName];
      account['name'] = accountName;

      var done = this.async();

      grunt.log.writeln('Refreshing access token.');
      var post_data = util.format('client_id=%s&client_secret=%s&refresh_token=%s&grant_type=refresh_token', account.client_id, account.client_secret, account.refresh_token);

      var req = https.request({
        host: 'accounts.google.com',
        path: '/o/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': post_data.length
        }
      }, function(res) {
        res.setEncoding('utf8');
        var response = '';
        res.on('data', function(chunk) {
          response += chunk;
        });
        res.on('end', function() {
          var obj = JSON.parse(response);
          if (obj.error) {
            grunt.log.writeln('Error: during access token request');
            grunt.log.writeln(response);
            done(new Error());
          } else {
            var token = obj.access_token;
            //set token for provided account
            accounts[accountName].token = token;
            done();
          }
        });
      });

      req.on('error', function(e) {
        console.log('Something went wrong', e.message);
        done(e);
      });

      req.write(post_data);
      req.end();
    });

    grunt.registerTask('uploading', 'uploading with token', function(extensionName) {
      var done = this.async();
      var promisses = [];
      var uploadConfig;
      var accountName;

      if (extensionName) {
        uploadConfig = extensions[extensionName];
        accountName = uploadConfig.account || 'default';

        uploadConfig['name'] = extensionName;
        uploadConfig['account'] = accounts[accountName];
        promisses.push(handleUpload(uploadConfig));
      } else {
        _.each(extensions, function(extension, extensionName) {
          var extensionConfigPath = extensionsConfigPath + '.' + extensionName;

          grunt.config.requires(extensionConfigPath);
          grunt.config.requires(extensionConfigPath + '.appID');
          grunt.config.requires(extensionConfigPath + '.zip');

          var uploadConfig = extension;
          var accountName = extension.account || 'default';

          uploadConfig['name'] = extensionName;
          uploadConfig['account'] = accounts[accountName];
          var p = handleUpload(uploadConfig);
          promisses.push(p);
        });
      }

      Q.allSettled(promisses).then(function(results) {
        var isError = false;
        results.forEach(function(result) {
          if (result.state === 'fulfilled') {
            var value = result.value;
          } else {
            isError = result.reason;
          }
        });

        if (isError) {
          grunt.log.writeln('================');
          grunt.log.writeln(' ');
          grunt.log.writeln('Error while uploading: ', isError);
          grunt.log.writeln(' ');
          done(new Error('Error while uploading'));
        } else {
          done();
        }
      });
    });

    if (taskName) {
      //upload specific extension
      var extensionConfigPath = extensionsConfigPath + '.' + taskName;

      grunt.config.requires(extensionConfigPath);
      grunt.config.requires(extensionConfigPath + '.appID');
      grunt.config.requires(extensionConfigPath + '.zip');

      var extensionConfig = grunt.config(extensionConfigPath);
      var accountName = extensionConfig.account || 'default';

      var account = accounts[accountName];

      // If a `refresh_token` exists in the config then use it instead of prompting the user
      var tokenStrategy = account.refresh_token !== undefined ?
        'refresh_account_token:'
        : 'get_account_token:';

      grunt.task.run([tokenStrategy + accountName, 'uploading:' + taskName]);

    } else {
      //upload all available extensions
      var tasks = [];

      //callculate tasks for accounts that we want to use
      var accountsTasksToUse = _.uniq(_.map(extensions, function(extension) {

        var name = (extension.account || 'default');
        var account = accounts[name];

        // If a `refresh_token` exists in the config then use it instead of prompting the user
        var tokenStrategy = account.refresh_token !== undefined ?
          'refresh_account_token:'
          : 'get_account_token:';

        return tokenStrategy + name;
      }));

      accountsTasksToUse.push('uploading');
      grunt.task.run(accountsTasksToUse);
    }
  });

  //upload zip
  function handleUpload(options) {
    var d = Q.defer();
    var doPublish = false;
    if (typeof options.publish !== 'undefined') {
      doPublish = options.publish;
    } else if (typeof options.account.publish !== 'undefined') {
      doPublish = options.account.publish;
    }
    //updating existing
    grunt.log.writeln('================');
    grunt.log.writeln(' ');
    grunt.log.writeln('Updating app (' + options.name + '): ', options.appID);
    grunt.log.writeln(' ');

    var filePath, readStream, zip,
        req = https.request({
          method: 'PUT',
          host: 'www.googleapis.com',
          path: util.format('/upload/chromewebstore/v1.1/items/%s', options.appID),
          headers: {
            'Authorization': 'Bearer ' + options.account.token,
            'x-goog-api-version': '2'
          }
        }, function(res) {
          res.setEncoding('utf8');
          var response = '';
          res.on('data', function(chunk) {
            response += chunk;
          });
          res.on('end', function() {
            var obj = JSON.parse(response);
            if (obj.uploadState !== 'SUCCESS') {
              // console.log('Error while uploading ZIP', obj);
              d.reject(obj.error ? obj.error.message : obj);
            } else {
              grunt.log.writeln(' ');
              grunt.log.writeln('Uploading done (' + options.name + ')');
              grunt.log.writeln(' ');
              if (doPublish) {
                publishItem(options).then(function() {
                  d.resolve();
                });
              } else {
                d.resolve();
              }
            }
          });
        });

    req.on('error', function(e) {
      grunt.log.error('Something went wrong (' + options.name + ')', e.message);
      d.resolve();
    });

    zip = options.zip;
    if (fs.statSync(zip).isDirectory()) {
      zip = getRecentFile(zip);
    }

    filePath = path.resolve(zip);
    grunt.log.writeln('Path to ZIP (' + options.name + '): ', filePath);
    grunt.log.writeln(' ');
    grunt.log.writeln('Uploading ' + options.name + '..');
    readStream = fs.createReadStream(filePath);

    readStream.on('end', function() {
      req.end();
    });

    readStream.pipe(req);

    return d.promise;
  }

  //make item published
  function publishItem(options) {
    var d = Q.defer();
    grunt.log.writeln('Publishing (' + options.name + ') ' + options.appID + '..');

    var url = util.format('/chromewebstore/v1.1/items/%s/publish', options.appID);
    if (options.publishTarget)
      url += '?publishTarget=' + options.publishTarget;

    var req = https.request({
      method: 'POST',
      host: 'www.googleapis.com',
      path: url,
      headers: {
        'Authorization': 'Bearer ' + options.account.token,
        'x-goog-api-version': '2',
        'Content-Length': '0'
      }
    }, function(res) {
      res.setEncoding('utf8');
      var response = '';
      res.on('data', function(chunk) {
        response += chunk;
      });
      res.on('end', function() {
        var obj = JSON.parse(response);
        if (obj.error) {
          console.log('Error while publishing (' + options.name + '). Please check configuration at Developer Dashboard', obj);
        } else {
          grunt.log.writeln('Publishing done (' + options.name + ')');
          grunt.log.writeln(' ');
        }
        d.resolve();
      });
    });

    req.on('error', function(e) {
      grunt.log.error('Something went wrong (' + options.name + ')', e.message);
      d.resolve();
    });
    req.end();

    return d.promise;
  }

  //return most recent chenged file in directory
  function getRecentFile(dirName) {
    var files = grunt.file.expand({ filter: 'isFile' }, dirName + '/*.zip'),
        mostRecentFile,
        currentFile;

    if (files.length) {
      for (var i = 0; i < files.length; i++) {
        currentFile = files[i];
        if (!mostRecentFile) {
          mostRecentFile = currentFile;
        } else {
          if (fs.statSync(currentFile).mtime > fs.statSync(mostRecentFile).mtime) {
            mostRecentFile = currentFile;
          }
        }
      }
      return mostRecentFile;
    } else {
      return false;
    }
  }

  function getPrivateDataByAccountName(accountName) {
    if (accountName === null) {
      console.log('Error: expected accountName to be provided.');
    } else {
      var privateDataFileName = '.webstoreUploadCredentials';

      if (fs.existsSync(privateDataFileName)) {
        var privateData = JSON.parse(grunt.file.read(privateDataFileName))[accountName];

        if (!privateData) {
          console.log('Error: failed to find privateData for accountName: ' + accountName);
        } else if (!privateData.client_id) {
          console.log('Error: failed to find privateData client_id for accountName:' + accountName);
        } else if (!privateData.client_secret) {
          console.log('Error: failed to find privatedata client_secret for accountName: ' + accountName);
        }

        return privateData;
      }
    }
  }

  // Request access token from code
  function requestToken(account, redirectUri, code, cb) {
    console.log('code', code);
    var post_data = util.format('client_id=%s&client_secret=%s&code=%s&grant_type=authorization_code&redirect_uri=%s', account.client_id, account.client_secret, code, redirectUri),
        req = https.request({
          host: 'accounts.google.com',
          path: '/o/oauth2/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': post_data.length
          }
        }, function(res) {

          res.setEncoding('utf8');
          var response = '';
          res.on('data', function(chunk) {
            response += chunk;
          });
          res.on('end', function() {
            var obj = JSON.parse(response);
            if (obj.error) {
              grunt.log.writeln('Error: during access token request');
              grunt.log.writeln(response);
              cb(new Error());
            } else {
              cb(null, obj.access_token);
            }
          });
        });

    req.on('error', function(e) {
      console.log('Something went wrong', e.message);
      cb(e);
    });

    req.write(post_data);
    req.end();
  }
  // get OAuth token using ssh-friendly cli
  function getTokenForAccountCli(account, cb) {
    var redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
    var codeUrl = util.format('https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=%s&redirect_uri=%s', account.client_id, redirectUri);
    var readline = require('readline');

    var rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question(util.format('Please open %s and enter code: ', codeUrl), function(code) {
      rl.close();
      requestToken(account, redirectUri, code, cb);
    });
  }

  //get OAuth token
  function getTokenForAccount(account, cb) {
    var exec = require('child_process').exec,
        port = 14809,
        callbackURL = util.format('http://localhost:%s', port),
        server = http.createServer(),
        codeUrl = util.format('https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&client_id=%s&redirect_uri=%s', account.client_id, callbackURL);

    grunt.log.writeln(' ');
    grunt.log.writeln('Authorization for account: ' + account.name);
    grunt.log.writeln('================');

    //due user interaction is required, we creating server to catch response and opening browser to ask user privileges
    server.on('connection', function(socket) {
      //reset Keep-Alive connetions in order to quick close server
      socket.setTimeout(1000);
    });
    server.on('request', function(req, res) {
      var code = url.parse(req.url, true).query['code'];  //user browse back, so code in url string
      if (code) {
        res.end('Got it! Authorizations for account "' + account.name + '" done. \ Check your console for new details. Tab now can be closed.');
        server.close(function() {
          requestToken(account, callbackURL, code, cb);
        });
      } else {
        res.end('<a href="' + codeUrl + '">Please click here and allow access for account "' + account.name + '", \ to continue uploading..</a>');
      }
    });
    server.listen(port, 'localhost');

    grunt.log.writeln(' ');
    grunt.log.writeln('Opening browser for authorization.. Please confirm privileges to continue..');
    grunt.log.writeln(' ');
    grunt.log.writeln(util.format('If the browser didn\'t open within a minute, please visit %s manually to continue', callbackURL));
    grunt.log.writeln(' ');

    open(codeUrl);
  }
};