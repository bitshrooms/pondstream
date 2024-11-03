const apiKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrcWp2d3h6c3hpbG5zbXBuZ21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjYwODExMjMsImV4cCI6MjA0MTY1NzEyM30.u9gf6lU2fBmf0aiC7SYH4vVeWMRnGRu4ZZ7xOGl-XuI';
let wsUrl = `wss://vkqjvwxzsxilnsmpngmc.supabase.co/realtime/v1/websocket?apikey=${apiKey}&eventsPerSecond=5&vsn=1.0.0`;

let socket;
let particles = [];
let sessions = {};
const TIMEOUT_DURATION = 300000; // 5 minutes

class MessageBuilder {
    static sentMsgs = [];
    static refs = {
        'realtime:blockengine': null,
        'realtime:peersx': null
    }

    constructor(apiKey) {
        this.apiKey = apiKey;
        this.sent_idx = 1;
    }

    joinPayload() {
        return {
            config: {
                broadcast: { ack: true },
                presence: { key: "" },
                postgres_changes: [],
                private: false,
            },
            access_token: this.apiKey,
        };
    }

    buildMessage(topic, event, payload, ref, join_ref) {
        const message = { topic, event, payload, ref };
        if (join_ref) {
            message.join_ref = join_ref;
        }
        return message;
    }

    realtimeTopicMessages(topic, ref, join_ref) {
        return {
            phx_join: this.buildMessage(topic, 'phx_join', this.joinPayload(), ref, join_ref),
            access_token: this.buildMessage(topic, 'access_token', { access_token: this.apiKey }, ref, join_ref),
        };
    }

    phoenixHeartbeat(ref) {
        return this.buildMessage('phoenix', 'heartbeat', {}, ref);
    }

    joinMessages() {
        MessageBuilder.refs['realtime:blockengine'] = this.sent_idx;
        let blockengine_join = this.realtimeTopicMessages('realtime:blockengine', this.sent_idx++, MessageBuilder.refs['realtime:blockengine']).phx_join;
        let blockengine_access = this.realtimeTopicMessages('realtime:blockengine', this.sent_idx++, MessageBuilder.refs['realtime:blockengine']).access_token;

        MessageBuilder.refs['realtime:peersx'] = this.sent_idx;
        let peersx_join = this.realtimeTopicMessages('realtime:peersx', this.sent_idx++, MessageBuilder.refs['realtime:peersx']).phx_join;
        let peersx_access = this.realtimeTopicMessages('realtime:peersx', this.sent_idx++, MessageBuilder.refs['realtime:peersx']).access_token;

        let phoenix_heartbeat = this.phoenixHeartbeat(this.sent_idx++);

        let msgs = [
            blockengine_join,
            blockengine_access,
            peersx_join,
            peersx_access,
            phoenix_heartbeat
        ];

        return msgs;
    }

    rejoinMessages() {
        let msgs = [
            this.realtimeTopicMessages('realtime:blockengine', this.sent_idx++, MessageBuilder.refs['realtime:blockengine']).access_token,
            this.realtimeTopicMessages('realtime:peersx', this.sent_idx++, MessageBuilder.refs['realtime:peersx']).access_token,
            this.phoenixHeartbeat(this.sent_idx++)
        ];
        return msgs;
    }

    sendMessages(ws, messages) {
        messages.forEach((message) => {
            ws.send(JSON.stringify(message));
            MessageBuilder.sentMsgs.push(message);
        });
    }
}

class ResponseMessage {
    constructor(msg) {
        this.msg = msg;

        this.topic = msg.topic || 'topic';
        this.event = msg.event;

        this.payload_1 = msg.payload;
        this.payload_2 = this.payload_1 && msg.payload.payload;
        this.payload_3 = this.payload_2 && msg.payload.payload.payload;
        this.payload_2_0 = this.payload_2 && msg.payload.payload[0];

        this.payload_1_event = this.payload_1 && this.payload_1.event;
        this.payload_1_status = this.payload_1 && this.payload_1.status;
        this.payload_2_message = this.payload_2 && this.payload_2.message;
        this.payload_2_status = this.payload_2 && this.payload_2.status;
        this.payload_2_0_status = this.payload_2_0 && this.payload_2_0.status;

        this.sig = this.payload_2 && this.payload_2.sig;
        this.key = this.payload_3 && this.payload_3.key;
    }

    hash() {
        let hash = `${this.event}|${this.payload_1_event}|${this.payload_1_status}|${this.payload_2_message}|${this.payload_2_status}|${this.payload_2_0_status}`.replace(/\|undefined/g, '');
        return hash;
    }
}

function setup() {
    createCanvas(windowWidth, windowHeight);
    connectWebSocket();
}

function connectWebSocket() {
    socket = new WebSocket(wsUrl);

    let msgBuilder = new MessageBuilder(apiKey);

    let stayAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
            msgBuilder.sendMessages(socket, msgBuilder.rejoinMessages());
        }
    }, 30000);

    socket.onopen = function() {
        msgBuilder.sendMessages(socket, msgBuilder.joinMessages());
    };

    socket.onmessage = function(event) {
        try {
            const msg = JSON.parse(event.data);
            msg._timestamp = new Date();

            let respMsg = new ResponseMessage(msg);
            respMsg.msg._hash = respMsg.hash();

            if (respMsg.sig) {
                const message = respMsg;
                const currTime = millis();

                if (!sessions[message.sig]) {
                    let x = random(width);
                    let y = random(height);

                    let mainParticle = new Particle(x, y, 10, [255 - random(50), 255 - random(50), 255 - random(50)]);
                    mainParticle.sig = message.sig;
                    sessions[message.sig] = {
                        particle: mainParticle,
                        subParticles: [],
                        lastMessageTime: currTime
                    };
                    particles.push(mainParticle);
                } else {
                    sessions[message.sig].lastMessageTime = currTime;
                }

                if (message.msg._hash === 'broadcast|valid|CLAIMING') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, true, [0, 255, 100]);
                } else if (message.msg._hash === 'broadcast|valid|RUNNING') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, false, [0, 150, 255]);
                } else if (message.msg._hash === 'broadcast|valid|EXPIRED') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, true, [139, 0, 0]);
                } else if (message.msg._hash === 'broadcast|valid|SLASHING') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, true, [255, 215, 0]);
                } else if (message.msg._hash === 'broadcast|valid|MINING') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, false, [193, 72, 228]);
                } else if (message.msg._hash === 'broadcast|valid|JOINING') {
                    createExplosion(sessions[message.sig], message.payload_2.reward, message.payload_2.boost || 0, false, [228, 72, 186]);
                } else if (message.msg._hash === 'broadcast|work|peer_hash_validation') {
                    createRecoilSubParticle(sessions[message.sig], message.payload_3.hash);
                } else {
                    createSubParticle(sessions[message.sig]);
                }
            }

        } catch (error) {
            console.error('Error parsing message:', error);
        }
    };

    socket.onerror = function(error) {
        console.error('WebSocket error:', error);
    };

    socket.onclose = function() {
        clearInterval(stayAlive);
        setTimeout(connectWebSocket, 1000);
    };
}

function draw() {
    background(0);

    const currTime = millis();

    particles = particles.filter(particle => {
        particle.update();
        particle.display();

        const session = sessions[particle.sig];
        if (session) {
            if (currTime - session.lastMessageTime > TIMEOUT_DURATION) {
                createExplosion(session, 500e6, 0, true, [255, 255, 255]);
                delete sessions[particle.sig];
                return false;
            }
        }

        if (particle.alpha <= 0) {
            if (session) {
                delete sessions[particle.sig];
            }
            return false;
        }
        return true;
    });

    Object.values(sessions).forEach(session => {
        session.subParticles = session.subParticles.filter(subParticle => {
            subParticle.update();
            subParticle.display();
            return subParticle.alpha > 0;
        });
    });
}

class Particle {
    constructor(x, y, size, color, isSubParticle = false) {
        this.pos = createVector(x, y);
        this.size = size;
        this.color = color;
        this.alpha = 255;
        this.isSubParticle = isSubParticle;
        this.sig = null;

        this.vel = isSubParticle ? p5.Vector.random2D().mult(random(0.5, 2)) : createVector(0, 0);
        this.acc = createVector(0, 0);
        this.maxSpeed = 5;
    }

    applyForce(force) {
        this.acc.add(force);
    }

    update() {
        if (this.isSubParticle) {
            this.alpha -= 2;
        } else {
            this.vel.limit(this.maxSpeed);
        }

        this.vel.add(this.acc);
        this.pos.add(this.vel);

        this.acc.mult(0);

        if (!this.isSubParticle) {
            this.checkEdges();
        }
    }

    checkEdges() {
        let radius = this.size / 2;

        if (this.pos.x - radius <= 0 || this.pos.x + radius >= width) {
            this.vel.x *= -1;
            this.pos.x = constrain(this.pos.x, radius, width - radius);
        }

        if (this.pos.y - radius <= 0 || this.pos.y + radius >= height) {
            this.vel.y *= -1;
            this.pos.y = constrain(this.pos.y, radius, height - radius);
        }
    }

    display() {
        noStroke();
        fill(...this.color, this.alpha);
        ellipse(this.pos.x, this.pos.y, this.size);
    }
}

function createSubParticle(session) {
    let parent = session.particle;
    let subParticleSize = 5;
    let color = [255 - random(50), 255 - random(50), 255 - random(50)];

    let subParticle = new Particle(parent.pos.x, parent.pos.y, subParticleSize, color, true);
    session.subParticles.push(subParticle);

    let recoilForce = subParticle.vel.copy().mult(-1);
    recoilForce.div(10);
    parent.applyForce(recoilForce);

    parent.color = color;
}

function createRecoilSubParticle(session, hashValue) {
    let parent = session.particle;

    let subParticleSize = map(hashValue, 0, 700, 3, 9);
    let subParticleSpeed = map(hashValue, 0, 700, 0.5, 3);
    let color = [255 - random(50), 255 - random(50), 255 - random(50)];

    let subParticle = new Particle(parent.pos.x, parent.pos.y, subParticleSize, color, true);
    subParticle.vel.setMag(subParticleSpeed);
    session.subParticles.push(subParticle);

    let recoilForce = subParticle.vel.copy().mult(-1);
    recoilForce.div(10);
    parent.applyForce(recoilForce);

    parent.color = color;

    parent.size = map(hashValue, 0, 700, 9, 18);
}

function createExplosion(session, reward, boost, shouldDie, color) {
    let parent = session.particle;
    let numParticles = shouldDie
        ? map(reward, 100e6, 1e9, 10, 100)
        : map(reward, 100e6, 1e9, 5, 20);

    let explosionSpeed = map(boost, 0, 400, 1, 5);

    for (let i = 0; i < numParticles; i++) {
        let subParticleSize = map(boost, 0, 400, 7, 16);

        let subParticleColor = color.map(c => constrain(c + random(-20, 20), 0, 255));

        let subParticle = new Particle(parent.pos.x, parent.pos.y, subParticleSize, subParticleColor, true);

        subParticle.vel.setMag(explosionSpeed);
        session.subParticles.push(subParticle);

        parent.color = subParticle.color;
    }

    if (shouldDie) {
        parent.alpha = 0;
    }
}

function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}
