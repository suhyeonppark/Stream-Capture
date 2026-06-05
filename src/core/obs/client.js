const OBSWebSocket = require('obs-websocket-js').default;

// EventSubscription bitfield (obs-websocket v5 protocol)
// All = General|Config|Scenes|Inputs|Transitions|Filters|Outputs|SceneItems|MediaInputs|Vendors|Ui
//     = (1<<0) | (1<<1) | ... | (1<<10) = 2047
// InputVolumeMeters는 high-volume이라 All에 포함되지 않으므로 별도로 OR 해야 한다.
const EVENT_SUBS_ALL = 2047;
const EVENT_SUB_INPUT_VOLUME_METERS = 1 << 16;
const EVENT_SUBSCRIPTIONS = EVENT_SUBS_ALL | EVENT_SUB_INPUT_VOLUME_METERS;

class ObsClient {
  constructor({ host, port, password }) {
    this.url = `ws://${host}:${port}`;
    this.password = password;
    this.obs = new OBSWebSocket();
    this.connected = false;
  }

  async connect() {
    await this.obs.connect(this.url, this.password, { eventSubscriptions: EVENT_SUBSCRIPTIONS });
    this.connected = true;
  }

  async disconnect() {
    if (this.connected) {
      await this.obs.disconnect();
      this.connected = false;
    }
  }

  call(request, args) {
    return this.obs.call(request, args);
  }

  on(event, handler) {
    this.obs.on(event, handler);
  }
}

module.exports = ObsClient;
