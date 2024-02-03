/*** MQTT Z-Way HA module ****************************************************

Version: 2.1.1
-----------------------------------------------------------------------------
Author: Robin Eggenkamp <robin@edubits.nl>, Ekaterina Volkova <ekaterina.volkova@wirenboard.ru>, Serguei Poltorak <ps@z-wave.me>
Description:
   Publishes the status of devices to a Wiren Board MQTT topic and is able
   to set values based on subscribed topics

   MQTTClient based on https://github.com/goodfield/zway-mqtt

 *****************************************************************************/


// ----------------------------------------------------------------------------
// --- Class definition, inheritance and setup
// ----------------------------------------------------------------------------

function WBMQTTNative(id, controller) {
	WBMQTTNative.super_.call(this, id, controller);
}

inherits(WBMQTTNative, AutomationModule);

_module = WBMQTTNative;

WBMQTTNative.prototype.log = function (message, level) {
	var self = this;

	if (undefined === message) return;
	switch (level) {
		case WBMQTTNative.LoggingLevel.DEBUG:
			if (!self.config.debug) {
				return;
			}
		case WBMQTTNative.LoggingLevel.INFO:
			console.log('[' + this.constructor.name + '-' + this.id + '] ' + message);
			break;
		default:
			break;
	}
};

WBMQTTNative.prototype.error = function (message) {
	if (undefined === message) message = 'An unknown error occured';
	var error = new Error(message);
	console.error('[' + this.constructor.name + '_' + this.id + '] ' + error.stack);
};

// ----------------------------------------------------------------------------
// --- Module instance initialized
// ----------------------------------------------------------------------------

WBMQTTNative.prototype.init = function (config) {
	// Call superclass' init (this will process config argument and so on)
	WBMQTTNative.super_.prototype.init.call(this, config);

	var self = this;

	if (config.groupByDevices === undefined) {
		this.config.groupByDevices = false;
	}

	// Defaults
	self.reconnectCount = 0;

	// Init MQTT client
	if (self.config.user != "none" && self.config.password != "none") {
		self.client = new mqtt(self.config.host, parseInt(self.config.port), self.config.user, self.config.password, self.config.clientId);
	}
	else {
		self.client = new mqtt(self.config.host, parseInt(self.config.port), self.config.clientId);
	}

	self.client.ondisconnect = function () { self.onDisconnect(); };
	self.client.onconnect = function () { self.onConnect(); };
	self.client.onmessage = function (topic, payload) { self.onMessage(topic, payload); };

	self.updateCallback = _.bind(self.updateDevice, self);
	self.addCallback = _.bind(self.addDevice, self);
	self.removeCallback = _.bind(self.removeDevice, self);

	self.connectionAttempt();
};

WBMQTTNative.prototype.stop = function () {
	var self = this;

	// Cleanup
	self.state = WBMQTTNative.ModuleState.DISCONNECTING;
	self.client.disconnect();

	self.removeReconnectionAttempt();

	WBMQTTNative.super_.prototype.stop.call(this);
};

// ----------------------------------------------------------------------------
// --- Module methods
// ----------------------------------------------------------------------------
WBMQTTNative.prototype.connectionAttempt = function () {
	var self = this;

	try {
		self.state = WBMQTTNative.ModuleState.CONNECTING;
		self.client.connect();
	} catch (exception) {
		self.log("MQTT connection error to " + self.config.host + " as " + self.config.clientId, WBMQTTNative.LoggingLevel.INFO);
		self.reconnectionAttempt();
	}
}

WBMQTTNative.prototype.reconnectionAttempt = function () {
	var self = this;

	self.reconnect_timer = setTimeout(function () {
		self.log("Trying to reconnect (" + self.reconnectCount + ")", WBMQTTNative.LoggingLevel.INFO);
		self.reconnectCount++;
		self.connectionAttempt();
	}, Math.min(self.reconnectCount * 1000, 60000));
}

WBMQTTNative.prototype.removeReconnectionAttempt = function () {
	// Clear any active reconnect timers
	var self = this;

	if (self.reconnect_timer) {
		clearTimeout(self.reconnect_timer);
		self.reconnect_timer = null;
	}
}

WBMQTTNative.prototype.onConnect = function () {
	var self = this;
	self.log("Connected to " + self.config.host + " as " + self.config.clientId, WBMQTTNative.LoggingLevel.INFO);

	self.controller.devices.on("change:metrics:level", self.updateCallback);
	self.controller.devices.on("change:updateTime", self.updateCallback);
	self.controller.devices.on('created', self.addCallback);
	self.controller.devices.on('removed', self.removeCallback);

	self.state = WBMQTTNative.ModuleState.CONNECTED
	self.reconnectCount = 0;

	if (!self.config.groupByDevices) {
		self.client.subscribe(self.config.topicPrefix + "/controls/+/" + self.config.topicPostfixSet);
	} // if groupByDevices == true, the subscription is made in init

	// Publish connected notification
	self.publish(self.config.topicPrefix + "/connected", "1", true);
	self.publish(self.config.topicPrefix + "/meta/name", "Z-Wave", true);

	self.controller.devices.each(function (device) {
		self.addDevice(device);
	});
}

WBMQTTNative.prototype.updateDevice = function (device) {
	var self = this;

	if (self.shouldSkip(device)) return;

	self.publishDeviceMeta(device);
	self.publishDeviceValue(device);
};

WBMQTTNative.prototype.addDevice = function (device) {
	var self = this;

	if (self.shouldSkip(device)) return;

	self.log("Add new device Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.INFO);
	self.publishDeviceMeta(device);
	self.publishDeviceValue(device);
	
	// Subscribe
	if (self.config.groupByDevices) {
		self.client.subscribe(self.getDeviceTopicPrefix(device) + "/controls/+/" + self.config.topicPostfixSet);
	} // if groupByDevices == false, the subscription is made in init
};

WBMQTTNative.prototype.removeDevice = function (device) {
	var self = this;

	if (self.shouldSkip(device)) return;

	self.log("Remove device Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.INFO);
	self.removeDeviceMeta(device);
	self.removeDeviceValue(device);
};

WBMQTTNative.prototype.onDisconnect = function () {
	var self = this;

	self.controller.devices.off("change:metrics:level", self.updateCallback);
	self.controller.devices.off("change:updateTime", self.updateCallback);
	self.controller.devices.off("created", self.addCallback);
	self.controller.devices.off("removed", self.removeCallback);

	if (self.state == WBMQTTNative.ModuleState.DISCONNECTING) {
		self.log("Disconnected due to module stop, not reconnecting", WBMQTTNative.LoggingLevel.INFO);
		return;
	}

	self.state == WBMQTTNative.ModuleState.DISCONNECTED
	self.error("Disconnected, will retry to connect...");
	self.reconnectionAttempt();
};

WBMQTTNative.prototype.onMessage = function (topic, payload) {
	var self = this;
	var payload = byteArrayToString(payload);

	if (!topic.endsWith(self.config.topicPostfixSet)) {
		self.log("New message topic does not end on topicPostfixSet", WBMQTTNative.LoggingLevel.INFO);
		self.log("Topic " + topic, WBMQTTNative.LoggingLevel.INFO);
		self.log("topicPostfixSet " + self.config.topicPostfixSet, WBMQTTNative.LoggingLevel.INFO);
		return;
	}

	var success = false;
	self.controller.devices.each(function (device) {
		var deviceTopic = self.getDeviceTopic(device);

		if (topic == deviceTopic + "/" + self.config.topicPostfixSet) {
			success = true;
			var deviceType = device.get('deviceType');

			self.log("New message topic" + topic + " payload " + payload, WBMQTTNative.LoggingLevel.DEBUG);
			self.log("Found device Id:" + device.get("id") + " DeviceType:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.DEBUG);

			switch (deviceType) {
				case WBMQTTNative.zWaveDeviceType.battery:
				case WBMQTTNative.zWaveDeviceType.sensorBinary:
				case WBMQTTNative.zWaveDeviceType.sensorMultilevel:
				case WBMQTTNative.zWaveDeviceType.toggleButton:
					device.performCommand(payload);
					break;
				case WBMQTTNative.zWaveDeviceType.doorlock:
					if (payload === "0") {
						device.performCommand("close");
					} else if (payload === "1") {
						device.performCommand("open");
					} else {
						device.performCommand(payload);
					}
					break;
				case WBMQTTNative.zWaveDeviceType.switchBinary:
					if (payload === "0") {
						device.performCommand("off");
					} else if (payload === "1") {
						device.performCommand("on");
					} else {
						device.performCommand(payload);
					}
					break;
				case WBMQTTNative.zWaveDeviceType.thermostat:
				case WBMQTTNative.zWaveDeviceType.switchMultilevel:
					var level = parseInt(payload);
					if (!isNaN(level)) {
						device.performCommand("exact", { level: payload });
					} else {
						device.performCommand(payload);
					}
					break;
				default:
					self.log("OnMessage callback does not support " + deviceType + " device type", WBMQTTNative.LoggingLevel.INFO);
					break;
			}
		}
	});

	if (!success) {
		self.log("Can't find the device with topic " + topic, WBMQTTNative.LoggingLevel.INFO);
	}
};


WBMQTTNative.prototype.publish = function (topic, value, retained) {
	var self = this;

	if (self.client && self.state == WBMQTTNative.ModuleState.CONNECTED) {
		self.client.publish(topic, (value !== undefined && value !== null) ? value.toString().trim() : "", retained);
	}
};

WBMQTTNative.prototype.getDeviceTopicPrefix = function (device) {
	if (this.config.groupByDevices) {
		var vDevId = device.get("id");
		var creatorId = device.get("creatorId");
		var bindingName = device.get("bindingName");
		var nodeId = device.get("nodeId");
		
		var groupId = this.config.topicPrefix;
		
		if (nodeId === undefined) {
			groupId += "-" + vDevId; // use vDevID as the group
		} else {
			// use physical nodeId as a group
			if (bindingName !== undefined) {
				groupId += "-" + bindingName;
			}
			groupId += "-" + nodeId;
		}
		
		return groupId;
	} else {
		return this.config.topicPrefix;
	}
};

WBMQTTNative.prototype.getDeviceTopic = function (device) {
	var self = this;
	return self.getDeviceTopicPrefix(device) + "/controls/" + WBMQTTNative.toTopicAffix(device.get("metrics:title")) + " " + WBMQTTNative.toTopicAffix(device.get("id").split("_").pop());
};

WBMQTTNative.prototype.getDeviceValue = function (device) {
	var self = this;
	var deviceType = device.get("deviceType");

	if (!(deviceType in WBMQTTNative.zWaveDeviceType)) {
		self.log("Can't get device value, unknown type Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.INFO);
		return;
	}

	var value = device.get("metrics:level");
	if (typeof value == "undefined") {
		var id = device.get("id");
		self.error("Device " + id + " metrics:level undefined");
		return;
	}

	switch (deviceType) {
		case WBMQTTNative.zWaveDeviceType.doorlock:
		case WBMQTTNative.zWaveDeviceType.switchBinary:
		case WBMQTTNative.zWaveDeviceType.switchControl:
		case WBMQTTNative.zWaveDeviceType.sensorBinary:
			if (value == 0 || value === "off" || value == "closed") {
				value = "0";
			} else if (value == 255 || value === "on" || value == "open") {
				value = "1";
			}
			break;
		default:
			break;
	}

	return {
		topic: self.getDeviceTopic(device),
		value: value
	};
};

WBMQTTNative.prototype.publishDeviceValue = function (device) {
	var self = this;

	var topicObj = self.getDeviceValue(device);
	
	if (topicObj === undefined) return;

	self.log("Publish Device Value Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.DEBUG);

	self.log(topicObj.topic + " " + topicObj.value, WBMQTTNative.LoggingLevel.DEBUG);
	self.publish(topicObj.topic, topicObj.value, true);
};

WBMQTTNative.prototype.removeDeviceValue = function (device) {
	var self = this;

	var topicObj = self.getDeviceValue(device);

	self.log("Remove Device Value Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.DEBUG);

	self.log(topicObj.topic + " " + topicObj.value, WBMQTTNative.LoggingLevel.DEBUG);
	self.publish(topicObj.topic, "", true);
};

WBMQTTNative.prototype.getDeviceMetaArray = function (device) {
	var self = this;

	var deviceType = device.get('deviceType');
	var deviceMetaTopic = self.getDeviceTopic(device) + "/meta";

	var metaTopicValue = new Array();
	var metaJSON = {};

	var addMetaTopicValue = function (topic, value) {
		metaJSON[topic] = value;
		//For old convention compatibility
		if (topic == "readonly") {
			value = (value == "true") ? "1" : "0"
		}
		metaTopicValue.push([deviceMetaTopic + "/" + topic, value]);
	}

	var addMetaJSON = function () {
		metaTopicValue.push([deviceMetaTopic, JSON.stringify(metaJSON)]);
	}

	addMetaTopicValue("z-wave_type", deviceType);
	switch (deviceType) {
		case WBMQTTNative.zWaveDeviceType.thermostat:
			addMetaTopicValue("type", "range");
			addMetaTopicValue("max", device.get("metrics:max"));
			break;
		case WBMQTTNative.zWaveDeviceType.doorlock:
		case WBMQTTNative.zWaveDeviceType.switchBinary:
		case WBMQTTNative.zWaveDeviceType.switchControl:
			addMetaTopicValue("type", "switch");
			break;
		case WBMQTTNative.zWaveDeviceType.switchMultilevel:
			addMetaTopicValue("type", "range");
			// Range [0;99] is caused by "max" command, which set level to 99.
			// In real case with Fibaro Dimmer 2 max level can be 100.
			addMetaTopicValue("max", 99);
			break;
		case WBMQTTNative.zWaveDeviceType.sensorBinary:
			addMetaTopicValue("type", "switch");
			addMetaTopicValue("readonly", "true");
			break;
		case WBMQTTNative.zWaveDeviceType.battery:
			addMetaTopicValue("updatetime", device.get("updateTime"));
			break;
		case WBMQTTNative.zWaveDeviceType.sensorMultilevel:
			addMetaTopicValue("type", "value");
			addMetaTopicValue("units", device.get("metrics:scaleTitle"));
			addMetaTopicValue("precision", self.config.precision)
			break;
		case WBMQTTNative.zWaveDeviceType.toggleButton:
			addMetaTopicValue("type", "pushbutton");
			break;
		default:
			//This case should be used for
			//this unsupported device types
			//sensorMultiline:"sensorMultiline",
			//sensorDiscrete:"sensorDiscrete",
			//camera: "camera",
			//text:"text",
			//switchRGB:"switchRGB"
			self.log("Can't get device meta, unsupported type Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.INFO);
			break;
	};
	addMetaJSON();

	return metaTopicValue;
}

WBMQTTNative.prototype.publishDeviceMeta = function (device) {
	var self = this;

	self.log("Publish Device Meta Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.DEBUG);

	var metaArray = self.getDeviceMetaArray(device);
	metaArray.forEach(function (item) {
		var value = item.pop();
		var topic = item.pop();
		self.publish(topic, value, true);
	});
};

WBMQTTNative.prototype.removeDeviceMeta = function (device) {
	var self = this;
	var metaArray = self.getDeviceMetaArray(device);

	self.log("Remove Device Meta Id:" + device.get("id") + " Type:" + device.get("deviceType"), WBMQTTNative.LoggingLevel.DEBUG);

	metaArray.forEach(function (item) {
		var value = item.pop();
		var topic = item.pop();
		self.publish(topic, "", true);
	});
};

WBMQTTNative.prototype.shouldSkip = function (device) {
	// skip devices created by the WBMQTTImport module (coming from MQTT broker we are publishing to)
	return device.get("id").startsWith("WBMQTTImport_");
};

// ----------------------------------------------------------------------------
// --- Utility methods
// ----------------------------------------------------------------------------


if (!String.prototype.toCamelCase) {
	String.prototype.toCamelCase = function () {
		return this
			.replace(/\s(.)/g, function ($1) { return $1.toUpperCase(); })
			.replace(/\s/g, '')
			.replace(/^(.)/, function ($1) { return $1.toLowerCase(); });
	};
}

if (!String.prototype.startsWith) {
	String.prototype.startsWith = function (s) {
		return this.length >= s.length && this.substr(0, s.length) == s;
	};
}

if (!String.prototype.endsWith) {
	String.prototype.endsWith = function (s) {
		return this.length >= s.length && this.substr(this.length - s.length) == s;
	};
}

WBMQTTNative.toTopicAffix = function (s) {
	return s
		.replace(/[+#]/g, "").replace(/\//g, "_");
};

// ----------------------------------------------------------------------------
// --- Device types enum
// ----------------------------------------------------------------------------

WBMQTTNative.zWaveDeviceType = Object.freeze({
	battery: "battery",
	doorlock: "doorlock",
	thermostat: "thermostat",
	switchBinary: "switchBinary",
	switchMultilevel: "switchMultilevel",
	sensorBinary: "sensorBinary",
	sensorMultilevel: "sensorMultilevel",
	toggleButton: "toggleButton",
	switchControl:"switchControl",
	//Unsupported device types
	//sensorMultiline:"sensorMultiline",
	//sensorDiscrete:"sensorDiscrete",
	//camera: "camera",
	//text:"text",
	//switchRGB:"switchRGB"
});

WBMQTTNative.LoggingLevel = Object.freeze({
	INFO: "INFO",
	DEBUG: "DEBUG"
});

WBMQTTNative.ModuleState = Object.freeze({
	CONNECTING: "CONNECTING",
	CONNECTED: "CONNECTED",
	DISCONNECTING: "DISCONNECTING",
	DISCONNECTED: "DISCONNECTED"
});