const EventEmitter = require('events');
const PrivateRoom = require('./PrivateRoom');
const MatchRoom = require('./MatchRoom');

// Twitch stuff
const TwitchAuth = require('twitch-auth');
const StaticAuthProvider = TwitchAuth.StaticAuthProvider;
const RefreshableAuthProvider = TwitchAuth.RefreshableAuthProvider;
const ChatClient = require('twitch-chat-client').ChatClient;

const USER_SESSION_TIMEOUT = 5 * 60 * 1000; // 5 minutes before we destroy user! TODO: Make tunable


function is_spam(msg) {
  if (/bigfollows\s*.\s*com/i.test(msg)) return true;

  return (
    /become famous/i.test(msg)
    &&
    /buy/i.test(msg)
  );
}


class User extends EventEmitter{
	constructor(user_object) {
		super();

		this.id                = user_object.id;
		this.login             = user_object.login;
		this.secret            = user_object.secret;
		this.email             = user_object.email;
		this.display_name      = user_object.display_name;
		this.description       = user_object.description;
		this.profile_image_url = user_object.profile_image_url;

		// TODO: create rooms lazily
		this.private_room = new PrivateRoom(this);
		this.match_room = new MatchRoom(this);

		// keep track of all socket for the user
		// dangerous, could lead to memory if not managed well
		this.destroy_to = null;
		this.connections = new Set();

		this.checkScheduleDestroy();
	}

	getPrivateRoom() {
		return this.private_room;
	}

	getMatchRoom() {
		return this.match_room;
	}

	closeRooms(reason) {
		// send message to all connections in all rooms that rooms are going away
		if (this.private_room) this.private_room.close(reason);
		if (this.match_room) this.match_room.close(reason);
	}

	setTwitchToken(token) {
		// in memory only, not in DB
		this.token = token;
		this.token.expiry = new Date(Date.now() + token.expires_in * 1000);
	}

	addConnection(conn) {
		this.connections.add(conn);

		conn.on('close', () => {
			this.connections.delete(conn);
			this.checkScheduleDestroy();
		});

		this.checkScheduleDestroy();

		this._connectToTwitchChat();
	}

	checkScheduleDestroy() {
		this.destroy_to = clearTimeout(this.destroy_to);

		if (this.connections.size > 0) return; // TODO: also check activity on the connections

		// User has no connection, we'll schedule his/her destruction
		this.destroy_to = setTimeout(
			() => this._onExpired(),
			USER_SESSION_TIMEOUT
		);
	}

	_send(msg) {
		const msg_str = JSON.stringify(msg);

		for (const connection in this.connections) {
			connection.send(msg_str);
		}
	}

	_onExpired() {
		console.log(`User ${this.login} is expiring`);

		this.closeRooms('expired');
		this.emit('expired');

		if (this.chat_client) {
			this.chat_client.quit();
		}
	}

	async _connectToTwitchChat() {
		if (this.chat_client || !this.token) {
			return;
		}

		const auth = new RefreshableAuthProvider(
			new StaticAuthProvider(
				process.env.TWITCH_CLIENT_ID,
				this.token.access_token,
			),
			{
				clientSecret: process.env.TWITCH_CLIENT_SECRET,
				refreshToken: this.token.refresh_token,
				expiry: this.token.expiry,
				onRefresh: ({ accessToken, refreshToken, expiryDate }) => {
					token.access_token = access_token;
					token.refresh_token = refresh_token;
					token.expiry = expiryDate;
				}
			}
		);

		this.chat_client = new ChatClient(auth, {
			channels: [ this.login ],
			readOnly: true,
		});

		this.chat_client.onMessage((channel, user, message) => {
			if (is_spam(message)) {
				// Bot.ban(user, 'spam'); // TODO: find API to do that
				return;
			}

			this._send(['message', {
				user:         user,
				username:     user,
				display_name: user,
				message:      message || ''
			}]);
		});

		this.chat_client.onSub((channel, user) => {
			this._send(['message', {
				user:         this.login,
				username:     this.login,
				display_name: this.display_name,
				message:      `Thanks to ${user} for subscribing to the channel!`
			}]);
		});

		this.chat_client.onRaid((channel, user, raidInfo) => {
			this._send(['message', {
				user:         this.login,
				username:     this.login,
				display_name: raidInfo.displayName,
				message:      `Woohoo! ${raidInfo.displayName} is raiding with a party of ${raidInfo.viewerCount}. Thanks for the raid ${raidInfo.displayName}!`
			}]);
		});

		await this.chat_client.connect();

		console.log(`TWITCH: chat_client connected for ${this.login}`);
	}
}

module.exports = User;