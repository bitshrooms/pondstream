(function(app) {
    class MessageBuilder {
        constructor(apiKey) {
            this.apiKey = apiKey;
            this.sentIdx = 1;
            this.refs = {
                'realtime:blockengine': null,
                'realtime:peersx': null,
            };
            this.sentMsgs = [];
        }

        joinPayload() {
            return {
                config: {
                    broadcast: { ack: true },
                    presence: { key: '' },
                    postgres_changes: [],
                    private: false,
                },
                access_token: this.apiKey,
            };
        }

        buildMessage(topic, event, payload, ref, joinRef) {
            const message = { topic, event, payload, ref };
            if (joinRef) {
                message.join_ref = joinRef;
            }
            return message;
        }

        realtimeTopicMessages(topic, ref, joinRef) {
            return {
                phx_join: this.buildMessage(topic, 'phx_join', this.joinPayload(), ref, joinRef),
                access_token: this.buildMessage(topic, 'access_token', { access_token: this.apiKey }, ref, joinRef),
            };
        }

        phoenixHeartbeat(ref) {
            return this.buildMessage('phoenix', 'heartbeat', {}, ref);
        }

        joinMessages() {
            this.refs['realtime:blockengine'] = this.sentIdx;
            const blockengineJoin = this.realtimeTopicMessages('realtime:blockengine', this.sentIdx++, this.refs['realtime:blockengine']).phx_join;
            const blockengineAccess = this.realtimeTopicMessages('realtime:blockengine', this.sentIdx++, this.refs['realtime:blockengine']).access_token;

            this.refs['realtime:peersx'] = this.sentIdx;
            const peersxJoin = this.realtimeTopicMessages('realtime:peersx', this.sentIdx++, this.refs['realtime:peersx']).phx_join;
            const peersxAccess = this.realtimeTopicMessages('realtime:peersx', this.sentIdx++, this.refs['realtime:peersx']).access_token;

            const phoenixHeartbeat = this.phoenixHeartbeat(this.sentIdx++);

            return [blockengineJoin, blockengineAccess, peersxJoin, peersxAccess, phoenixHeartbeat];
        }

        rejoinMessages() {
            return [
                this.realtimeTopicMessages('realtime:blockengine', this.sentIdx++, this.refs['realtime:blockengine']).access_token,
                this.realtimeTopicMessages('realtime:peersx', this.sentIdx++, this.refs['realtime:peersx']).access_token,
                this.phoenixHeartbeat(this.sentIdx++),
            ];
        }

        sendMessages(ws, messages) {
            messages.forEach((message) => {
                ws.send(JSON.stringify(message));
                this.sentMsgs.push(message);
            });
        }
    }

    class ResponseMessage {
        constructor(msg) {
            this.msg = msg;
            this.topic = msg.topic || 'topic';
            this.event = msg.event;

            this.payload1Event = msg.payload?.event;
            this.payload1Status = msg.payload?.status;
            this.payload2Message = msg.payload?.payload?.message;
            this.payload2Status = msg.payload?.payload?.status;
            this.payload2_0Status = Array.isArray(msg.payload?.payload)
                ? msg.payload.payload[0]?.status
                : undefined;

            this.sig = msg.payload?.payload?.sig;
            this.key = msg.payload?.payload?.payload?.key;
            this.reward = Number(msg.payload?.payload?.reward) || 0;
            this.boost = Number(msg.payload?.payload?.boost) || 0;
            this.hashValue = Number(msg.payload?.payload?.payload?.hash) || 0;
        }

        hash() {
            let hashComponents = [
                this.event,
                this.payload1Event,
                this.payload1Status,
                this.payload2Message,
                this.payload2Status,
                this.payload2_0Status,
            ];
            return hashComponents.filter(Boolean).join('|');
        }
    }

    function connectWebSocket() {
        const CONFIG = app.CONFIG;
        const wsUrl = app.getWebSocketUrl();
        app.socket = new WebSocket(wsUrl);
        const messageBuilder = new MessageBuilder(CONFIG.API_KEY);
        app.reconnectAttempts = 0;

        app.stayAlive = setInterval(() => {
            if (app.socket.readyState === WebSocket.OPEN) {
                messageBuilder.sendMessages(app.socket, messageBuilder.rejoinMessages());
            }
        }, CONFIG.HEARTBEAT_INTERVAL);

        app.socket.onopen = () => {
            app.reconnectAttempts = 0;
            messageBuilder.sendMessages(app.socket, messageBuilder.joinMessages());
        };

        app.socket.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (!app.isValidMessage(msg)) {
                    throw new Error('Invalid message format');
                }
                msg._timestamp = new Date();
                const responseMessage = new ResponseMessage(msg);
                responseMessage.msg._hash = responseMessage.hash();
                if (responseMessage.sig) {
                    app.handleIncomingMessage(responseMessage);
                }
            } catch (error) {
                console.error('Error parsing message:', {
                    error,
                    data: event.data,
                    time: new Date(),
                });
            }
        };

        app.socket.onerror = (error) => {
            console.error('WebSocket error:', {
                error,
                url: wsUrl,
                time: new Date(),
            });
        };

        app.socket.onclose = () => {
            clearInterval(app.stayAlive);
            const timeout = Math.min(1000 * 2 ** app.reconnectAttempts, CONFIG.MAX_RECONNECT_DELAY);
            setTimeout(connectWebSocket, timeout);
            app.reconnectAttempts++;
        };
    }

    app.getWebSocketUrl = function() {
        const params = new URLSearchParams({
            apikey: app.CONFIG.API_KEY,
            eventsPerSecond: app.CONFIG.EVENTS_PER_SECOND,
            vsn: app.CONFIG.VSN,
        });
        return `${app.CONFIG.WS_URL}?${params.toString()}`;
    };

    app.MessageBuilder = MessageBuilder;
    app.ResponseMessage = ResponseMessage;
    app.connectWebSocket = connectWebSocket;

})(window.POND);
