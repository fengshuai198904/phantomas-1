/**
 * phantomas main file
 */

var VERSION = '0.1';
var TIMEOUT = 10000; // ms

var phantomas = function(params) {
	// parse script CLI parameters
	this.params = params;

	// --url=http://example.com
	this.url = this.params.url;

	// --format=[csv|json]
	this.resultsFormat = params.format || 'plain';

	// --viewport=1280x1024
	this.viewport = params.viewport || '1280x1024';

	// --verbose
	this.verboseMode = params.verbose === true;

	// setup the stuff
	this.emitter = new (require('events').EventEmitter)();
	this.metrics = {};
	this.notices = [];
	this.page = require('webpage').create();

	// current HTTP requests counter
	this.currentRequests = 0;

	this.version = VERSION;

	this.log('phantomas v' + this.version);

	// load core modules
	this.addCoreModule('requestsMonitor');
};

exports.phantomas = phantomas;

phantomas.prototype = {
	// simple version of jQuery.proxy
	proxy: function(fn, scope) {
		scope = scope || this;
		return function () {
			return fn.apply(scope, arguments);
		}
	},

	// emit given event
	emit: function(/* eventName, arg1, arg2, ... */) {
		this.log('Event ' + arguments[0] + ' emitted');
		this.emitter.emit.apply(this.emitter, arguments);
	},

	// bind to a given event
	on: function(ev, fn) {
		this.emitter.on(ev, fn);
	},

	once: function(ev, fn) {
		this.emitter.once(ev, fn);
	},

	// returns "wrapped" version of phantomas object with public methods / fields only
	getPublicWrapper: function() {
		var self = this;

		// modules API
		return {
			url: this.params.url,
			params: this.params,

			// events
			on: function() {self.on.apply(self, arguments)},
			once: function() {self.once.apply(self, arguments)},
			emit: function() {self.emit.apply(self, arguments)},

			// metrics
			setMetric: function() {self.setMetric.apply(self, arguments)},
			setMetricEvaluate: function() {self.setMetricEvaluate.apply(self, arguments)},
			incrMetric: function() {self.incrMetric.apply(self, arguments)},

			// debug
			addNotice: function(msg) {self.addNotice(msg)},
			log: function(msg) {self.log(msg)},

			// phantomJS
			evaluate: function(fn) {return self.page.evaluate(fn)},
			injectJs: function(src) {return self.page.injectJs(src)}
		};
	},

	// initialize given core phantomas module
	addCoreModule: function(name) {
		var pkg = require('./modules/' + name + '/' + name);

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Core module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
	},

	// initialize given phantomas module
	addModule: function(name) {
		var pkg = require('./../modules/' + name + '/' + name);

		// init a module
		pkg.module(this.getPublicWrapper());

		this.log('Module ' + name + (pkg.version ? ' v' + pkg.version : '') + ' initialized');
	},
 
	// runs phantomas
	run: function() {

		// check required params
		if (!this.url) {
			throw '--url argument must be provided!';
		}

		this.start = Date.now();

		// setup viewport
		var parsedViewport = this.viewport.split('x');

		if (parsedViewport.length === 2) {
			this.page.viewportSize = {
				height: parseInt(parsedViewport[0], 10) || 1280,
				width: parseInt(parsedViewport[1], 10) || 1024
			};
		}

		// print out debug messages
		this.log('Opening <' + this.url + '>...');
		this.log('Using ' + this.page.settings.userAgent);
		this.log('Viewport ' + this.page.viewportSize.height + 'x' + this.page.viewportSize.width);

		// bind basic events
		this.page.onInitialized = this.proxy(this.onInitialized);
		this.page.onLoadStarted = this.proxy(this.onLoadStarted);
		this.page.onLoadFinished = this.proxy(this.onLoadFinished);
		this.page.onResourceRequested = this.proxy(this.onResourceRequested);
		this.page.onResourceReceived = this.proxy(this.onResourceReceived);

		// debug
		this.page.onAlert = this.proxy(this.onAler);
		this.page.onConsoleMessage = this.proxy(this.onConsoleMessage);

		// observe HTTP requests
		// finish when the last request is completed
		
		// update HTTP requests counter	
		this.on('send', this.proxy(function(entry) {
			this.currentRequests++;
			//this.log('send ' + this.currentRequests + ' ' + entry.url);
		}));
	
		this.on('recv', this.proxy(function(entry) {
			this.currentRequests--;
			//this.log('recv ' + this.currentRequests + ' ' + entry.url);

			// TODO: remove c&p
			if (this.currentRequests < 1) {
				this.log('HTTP requests completed!');

				clearTimeout(this.lastRequestTimeout);
				this.lastRequestTimeout = setTimeout(this.proxy(this.report), 500);
			}
		}));

		// last time changes?
		this.emit('pageBeforeOpen', this.page);

		// open the page
		this.page.open(this.url, this.onPageOpened);

		this.emit('pageOpen');

		// fallback - always timeout after 7 seconds
		setTimeout(this.proxy(function() {
			this.log('Timeout of ' + TIMEOUT + ' ms was reached!');
			this.report();
		}), TIMEOUT);
	},

	// called when all HTTP requests are completed
	report: function() {
		this.emit('report');

		var time = Date.now() - this.start;
		this.log('phantomas work done in ' + time + ' ms');

		// format results
		var results = {
			url: this.url,
			metrics: this.metrics,
			notices: this.notices
		};

		this.log('Formatting results (' + this.resultsFormat + ')');

		// render results
		var formatter = require('./formatter').formatter,
			renderer = new formatter(results, this.resultsFormat);

		console.log(renderer.render());

		this.page.release();
		phantom.exit();
	},

	// core events
	onInitialized: function() {
		// add helper tools into window.phantomas "namespace"
		this.page.injectJs('./core/helper.js');

		this.log('Page object initialized');
		this.emit('init');
	},

	onLoadStarted: function() {
		this.log('Page loading started');
		this.emit('loadStarted');
	},

	onResourceRequested: function(res) {
		this.emit('onResourceRequested', res);
		//this.log(JSON.stringify(res));
	},

	onResourceReceived: function(res) {
		this.emit('onResourceReceived', res);
		//this.log(JSON.stringify(res));
	},

	onLoadFinished: function(status) {
		// trigger this only once
		if (this.onLoadFinishedEmitted) {
			return;
		}
		this.onLoadFinishedEmitted = true;

		// we're done
		this.log('Page loading finished ("' + status + '")');

		switch(status) {
			case 'success':
				this.emit('loadFinished', status);
				break;
		
			default:
				this.emit('loadFailed', status);
				break;
		}

		// TODO: remove c&p
		if (this.currentRequests < 1) {
			clearTimeout(this.lastRequestTimeout);
			this.lastRequestTimeout = setTimeout(this.proxy(this.report), 500);
		}
	},

	// debug
	onAlert: function(msg) {
		this.log('Alert: ' + msg);
		this.emit('alert', msg);
	},

	onConsoleMessage: function(msg) {
		this.log('console.log: ' + msg);
		this.emit('consoleLog', msg);
	},

	// metrics reporting
	setMetric: function(name, value) {
		this.metrics[name] = (typeof value !== 'undefined') ? value : 0;
	},

	setMetricEvaluate: function(name, fn) {
		this.setMetric(name, this.page.evaluate(fn));
	},

	// increements given metric by given number (default is one)
	incrMetric: function(name, incr /* =1 */) {
		this.metrics[name] = (this.metrics[name] || 0) + (incr || 1);
	},

	// adds a notice that will be emitted after results
	addNotice: function(msg) {
		this.notices.push(msg || '');
	},

	// add log message
	// will be printed out only when --verbose
	log: function(msg) {
		if (this.verboseMode) {
			msg = (typeof msg === 'object') ? JSON.stringify(msg) : msg;

			console.log('> ' + msg);
		}
	}
};