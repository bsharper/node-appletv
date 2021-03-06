import { Service } from 'mdns';
import * as path from 'path';
import { load, Message as ProtoMessage } from 'protobufjs'
import { v4 as uuid } from 'uuid';
import { EventEmitter } from 'events';
import { Socket } from 'net';

import { Connection } from './connection';
import { Pairing } from './pairing'; 
import { Verifier } from './verifier';
import { Credentials } from './credentials';
import { NowPlayingInfo } from './now-playing-info';
import { SupportedCommand } from './supported-command';
import { Message } from './message';
import number from './util/number';

interface StateRequestCallback {
  id: string;
  resolve: (any) => void;
  reject: (Error) => void;
}

export interface Size {
  width: number;
  height: number;
}

export interface PlaybackQueueRequestOptions {
  location: number;
  length: number;
  includeMetadata?: boolean;
  includeLanguageOptions?: boolean;
  includeLyrics?: boolean;
  artworkSize?: Size;
}

export interface ClientUpdatesConfig {
  artworkUpdates: boolean;
  nowPlayingUpdates: boolean;
  volumeUpdates: boolean;
  keyboardUpdates: boolean;
}

export class AppleTV extends EventEmitter /* <AppleTV.Events> */ {
  public name: string;
  public address: string;
  public port: number;
  public uid: string;
  public pairingId: string = uuid();
  public credentials: Credentials;
  public connection: Connection;

  private queuePollTimer?: any;

  constructor(private service: Service, socket?: Socket) {
    super();

    this.service = service;
    this.name = service.txtRecord.Name;
    this.address = service.addresses.filter(x => x.includes('.'))[0];
    this.port = service.port;
    this.uid = service.txtRecord.UniqueIdentifier;
    this.connection = new Connection(this, socket);

    this.setupListeners();
  }

  /**
  * Pair with an already discovered AppleTV.
  * @returns A promise that resolves to the AppleTV object.
  */
  pair(): Promise<(pin: string) => Promise<AppleTV>> {
    let pairing = new Pairing(this);
    return pairing.initiatePair();
  }

  /**
  * Opens a connection to the AppleTV over the MRP protocol.
  * @param credentials  The credentials object for this AppleTV
  * @returns A promise that resolves to the AppleTV object.
  */
  async openConnection(credentials?: Credentials): Promise<AppleTV> {
    if (credentials) {
      this.pairingId = credentials.pairingId;      
    }
    
    await this.connection.open();
    await this.sendIntroduction();
    this.credentials = credentials;
    if (credentials) {
      let verifier = new Verifier(this);
      let keys = await verifier.verify();
      this.credentials.readKey = keys['readKey'];
      this.credentials.writeKey = keys['writeKey'];
      this.emit('debug', "DEBUG: Keys Read=" + this.credentials.readKey.toString('hex') + ", Write=" + this.credentials.writeKey.toString('hex'));
      await this.sendConnectionState();
    }

    if (credentials) {
      await this.sendClientUpdatesConfig({
        nowPlayingUpdates: true,
        artworkUpdates: true,
        keyboardUpdates: false,
        volumeUpdates: false
      });
    }

    return this;
  }

  /**
  * Closes the connection to the Apple TV.
  */
  closeConnection() {
    this.connection.close();
  }

  /**
  * Send a Protobuf message to the AppleTV. This is for advanced usage only.
  * @param definitionFilename  The Protobuf filename of the message type.
  * @param messageType  The name of the message.
  * @param body  The message body
  * @param waitForResponse  Whether or not to wait for a response before resolving the Promise.
  * @returns A promise that resolves to the response from the AppleTV.
  */
  async sendMessage(definitionFilename: string, messageType: string, body: {}, waitForResponse: boolean, priority: number = 0): Promise<Message> {
    let root = await load(path.resolve(__dirname + "/protos/" + definitionFilename + ".proto"));
    let type = root.lookupType(messageType);
    let message = await type.create(body);

    return this.connection.send(message, waitForResponse, priority, this.credentials);
  }

  /**
  * Wait for a single message of a specified type.
  * @param type  The type of the message to wait for.
  * @param timeout  The timeout (in seconds).
  * @returns A promise that resolves to the Message.
  */
  messageOfType(type: Message.Type, timeout: number = 5): Promise<Message> {
    let that = this;
    return new Promise<Message>((resolve, reject) => {
      let listener: (message: Message) => void;
      let timer = setTimeout(() => {
        reject(new Error("Timed out waiting for message type " + type));
        that.removeListener('message', listener);
      }, timeout * 1000);
      listener = (message: Message) => {
        if (message.type == type) {
          resolve(message);
          that.removeListener('message', listener);
        }
      };
      that.on('message', listener);
    });
  }

  /**
  * Requests the current playback queue from the Apple TV.
  * @param options Options to send
  * @returns A Promise that resolves to a NewPlayingInfo object.
  */
  requestPlaybackQueue(options: PlaybackQueueRequestOptions): Promise<NowPlayingInfo> {
    return this.requestPlaybackQueueWithWait(options, true);
  }

  /**
  * Requests the current artwork from the Apple TV.
  * @param width Image width
  * @param height Image height
  * @returns A Promise that resolves to a Buffer of data.
  */
  async requestArtwork(width: number = 400, height: number = 400): Promise<Buffer> {
    let response = await this.requestPlaybackQueueWithWait({
      artworkSize: {
        width: width,
        height: height
      },
      length: 1,
      location: 0
    }, true);
    
    let data = response?.payload?.playbackQueue?.contentItems?.[0]?.artworkData;

    if (data) {
      return data;
    } else {
      throw new Error("No artwork available");
    }
  }

  /**
  * Send a key command to the AppleTV.
  * @param key The key to press.
  * @returns A promise that resolves to the AppleTV object after the message has been sent.
  */
  sendKeyCommand(key: AppleTV.Key): Promise<AppleTV> {
    switch (key) {
      case AppleTV.Key.Up:
        return this.sendKeyPressAndRelease(1, 0x8C);
      case AppleTV.Key.Down:
        return this.sendKeyPressAndRelease(1, 0x8D);
      case AppleTV.Key.Left:
        return this.sendKeyPressAndRelease(1, 0x8B);
      case AppleTV.Key.Right:
        return this.sendKeyPressAndRelease(1, 0x8A);
      case AppleTV.Key.Menu:
        return this.sendKeyPressAndRelease(1, 0x86);
      case AppleTV.Key.Play:
        return this.sendKeyPressAndRelease(12, 0xB0);
      case AppleTV.Key.Pause:
        return this.sendKeyPressAndRelease(12, 0xB1);
      case AppleTV.Key.Next:
        return this.sendKeyPressAndRelease(12, 0xB5);
      case AppleTV.Key.Previous:
        return this.sendKeyPressAndRelease(12, 0xB6);
      case AppleTV.Key.Suspend:
        return this.sendKeyPressAndRelease(1, 0x82);
      case AppleTV.Key.Select:
        return this.sendKeyPressAndRelease(1, 0x89);
    }
  }

  waitForSequence(sequence: number, timeout: number = 3): Promise<Message> {
    return this.connection.waitForSequence(sequence, timeout);
  }

  private sendKeyPressAndRelease(usePage: number, usage: number): Promise<AppleTV> {
    let that = this;
    return this.sendKeyPress(usePage, usage, true)
      .then(() => {
        return that.sendKeyPress(usePage, usage, false);
      });
  }

  private sendKeyPress(usePage: number, usage: number, down: boolean): Promise<AppleTV> {
    let time = Buffer.from('438922cf08020000', 'hex');
    let data = Buffer.concat([
      number.UInt16toBufferBE(usePage),
      number.UInt16toBufferBE(usage),
      down ? number.UInt16toBufferBE(1) : number.UInt16toBufferBE(0)
    ]);

    let body = {
      hidEventData: Buffer.concat([
        time,
        Buffer.from('00000000000000000100000000000000020' + '00000200000000300000001000000000000', 'hex'),
        data,
        Buffer.from('0000000000000001000000', 'hex')
      ])
    };
    let that = this;
    return this.sendMessage("SendHIDEventMessage", "SendHIDEventMessage", body, false)
      .then(() => {
        return that;
      });
  }

  private requestPlaybackQueueWithWait(options: PlaybackQueueRequestOptions, waitForResponse: boolean): Promise<any> {
    var params: any = options;
    params.requestID = uuid();
    if (options.artworkSize) {
      params.artworkWidth = options.artworkSize.width;
      params.artworkHeight = options.artworkSize.height;
      delete params.artworkSize;
    }
    return this.sendMessage("PlaybackQueueRequestMessage", "PlaybackQueueRequestMessage", params, waitForResponse);
  }

  private sendIntroduction(): Promise<Message> {
    let body = {
      uniqueIdentifier: this.pairingId,
      name: 'node-appletv',
      localizedModelName: 'iPhone',
      systemBuildVersion: '14G60',
      applicationBundleIdentifier: 'com.apple.TVRemote',
      applicationBundleVersion: '320.18',
      protocolVersion: 1,
      allowsPairing: true,
      lastSupportedMessageType: 45,
      supportsSystemPairing: true,
    };
    return this.sendMessage('DeviceInfoMessage', 'DeviceInfoMessage', body, true);
  }

  private sendConnectionState(): Promise<Message> {
    let that = this;
    return load(path.resolve(__dirname + "/protos/SetConnectionStateMessage.proto"))
      .then(root => {
        let type = root.lookupType('SetConnectionStateMessage');
        let stateEnum = type.lookupEnum('ConnectionState');
        let message = type.create({
          state: stateEnum.values['Connected']
        });

        return that
          .connection
          .send(message, false, 0, that.credentials);
      });
  }

  private sendClientUpdatesConfig(config: ClientUpdatesConfig): Promise<Message> {
    return this.sendMessage('ClientUpdatesConfigMessage', 'ClientUpdatesConfigMessage', config, false);
  }

  private sendWakeDevice(): Promise<Message> {
    return this.sendMessage('WakeDeviceMessage', 'WakeDeviceMessage', {}, false);
  }

  private onReceiveMessage(message: Message) {
    this.emit('message', message);
    if (message.type == Message.Type.SetStateMessage) {
      if (message.payload == null) {
        this.emit('nowPlaying', null);
        return;
      }
      if (message.payload.nowPlayingInfo) {
        let info = new NowPlayingInfo(message.payload);
        this.emit('nowPlaying', info);
      }
      if (message.payload.supportedCommands) {
        let commands = (message.payload.supportedCommands.supportedCommands || [])
          .map(sc => {
            return new SupportedCommand(sc.command, sc.enabled || false, sc.canScrub || false);
          });
        this.emit('supportedCommands', commands);
      }
      if (message.payload.playbackQueue) {
        this.emit('playbackQueue', message.payload.playbackQueue);
      }
    }
  }

  private onNewListener(event: string, listener: any) {
    let that = this;
    if (this.queuePollTimer == null && (event == 'nowPlaying' || event == 'supportedCommands')) {
      this.queuePollTimer = setInterval(() => {
        if (that.connection.isOpen) {
          that.requestPlaybackQueueWithWait({
            length: 100,
            location: 0,
            artworkSize: {
              width: -1,
              height: 368
            }
          }, false).then(() => {}).catch(error => {});
        }
      }, 5000);
    }
  }

  private onRemoveListener(event: string, listener: any) {
    if (this.queuePollTimer != null && (event == 'nowPlaying' || event == 'supportedCommands')) {
      let listenerCount = this.listenerCount('nowPlaying') + this.listenerCount('supportedCommands');
      if (listenerCount == 0) {
        clearInterval(this.queuePollTimer);
        this.queuePollTimer = null;
      }
    }
  }

  private setupListeners() {
    let that = this;
    this.connection.on('message', (message: Message) => {
      that.onReceiveMessage(message);
    })
    .on('connect', () => {
      that.emit('connect');
    })
    .on('close', () => {
      that.emit('close');
    })
    .on('error', (error) => {
      that.emit('error', error);
    })
    .on('debug', (message) => {
      that.emit('debug', message);
    });

    this.on('newListener', (event, listener) => {
      that.onNewListener(event, listener);
    });
    this.on('removeListener', (event, listener) => {
      that.onRemoveListener(event, listener);
    });
  }
}

export module AppleTV {
  export interface Events {
    connect: void;
    nowPlaying: NowPlayingInfo;
    supportedCommands: SupportedCommand[];
    playbackQueue: any;
    message: Message
    close: void;
    error: Error;
    debug: string;
  }
}

export module AppleTV {
  /** An enumeration of key presses available.
  */
  export enum Key {
    Up,
    Down,
    Left,
    Right,
    Menu,
    Play,
    Pause,
    Next,
    Previous,
    Suspend,
    Select
  }

  /** Convert a string representation of a key to the correct enum type.
  * @param string  The string.
  * @returns The key enum value.
  */
  export function key(string: string): AppleTV.Key {
    if (string == "up") {
      return AppleTV.Key.Up;
    } else if (string == "down") {
      return AppleTV.Key.Down;
    } else if (string == "left") {
      return AppleTV.Key.Left;
    } else if (string == "right") {
      return AppleTV.Key.Right;
    } else if (string == "menu") {
      return AppleTV.Key.Menu;
    } else if (string == "play") {
      return AppleTV.Key.Play;
    } else if (string == "pause") {
      return AppleTV.Key.Pause;
    } else if (string == "next") {
      return AppleTV.Key.Next;
    } else if (string == "previous") {
      return AppleTV.Key.Previous;
    } else if (string == "suspend") {
      return AppleTV.Key.Suspend;
    } else if (string == "select") {
      return AppleTV.Key.Select;
    }
  }
}
