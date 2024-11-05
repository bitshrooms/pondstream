'use strict';

// Configuration Object
const CONFIG = {
    TIMEOUT_DURATION: 300000, // 5 minutes
    WS_URL: 'wss://vkqjvwxzsxilnsmpngmc.supabase.co/realtime/v1/websocket',
    EVENTS_PER_SECOND: 5,
    VSN: '1.0.0',
    HEARTBEAT_INTERVAL: 30000, // 30 seconds
    MAX_RECONNECT_DELAY: 30000, // 30 seconds
    API_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrcWp2d3h6c3hpbG5zbXBuZ21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjYwODExMjMsImV4cCI6MjA0MTY1NzEyM30.u9gf6lU2fBmf0aiC7SYH4vVeWMRnGRu4ZZ7xOGl-XuI'
};

// Helper function to get the WebSocket URL with query parameters
function getWebSocketUrl() {
    const params = new URLSearchParams({
        apikey: CONFIG.API_KEY,
        eventsPerSecond: CONFIG.EVENTS_PER_SECOND,
        vsn: CONFIG.VSN,
    });
    return `${CONFIG.WS_URL}?${params.toString()}`;
}

// Global Variables
let socket;
let particles = [];
let sessions = new Map();
let reconnectAttempts = 0;
let isTabVisible = true;
let startTime = Date.now();

let stats = {
    claimed: 0,
    slashed: 0,
    expired: 0,
    hashes: 0,
    max: {
        reward: 0,//1e9,
        boost: 0,//400,
        hash: 0,//700
    }
}

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const wallet = {
    key: urlParams.get('wallet'),
    sig: null
}

// Class to manage WebSocket messages
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

// Class to parse and handle incoming messages
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

// Initialize p5.js setup
function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    // frameRate(60);
    connectWebSocket();
}

// Function to connect to the WebSocket server
function connectWebSocket() {
    const wsUrl = getWebSocketUrl();
    socket = new WebSocket(wsUrl);
    const messageBuilder = new MessageBuilder(CONFIG.API_KEY);

    // Keep the connection alive with heartbeats
    const stayAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
            messageBuilder.sendMessages(socket, messageBuilder.rejoinMessages());
        }
    }, CONFIG.HEARTBEAT_INTERVAL);

    socket.onopen = () => {
        reconnectAttempts = 0;
        messageBuilder.sendMessages(socket, messageBuilder.joinMessages());
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (!isValidMessage(msg)) {
                throw new Error('Invalid message format');
            }

            msg._timestamp = new Date();
            const responseMessage = new ResponseMessage(msg);
            responseMessage.msg._hash = responseMessage.hash();

            if (responseMessage.sig) {
                handleIncomingMessage(responseMessage);
            }
        } catch (error) {
            console.error('Error parsing message:', {
                error,
                data: event.data,
                time: new Date(),
            });
        }
    };

    socket.onerror = (error) => {
        console.error('WebSocket error:', {
            error,
            url: wsUrl,
            time: new Date(),
        });
    };

    socket.onclose = () => {
        clearInterval(stayAlive);
        const timeout = Math.min(1000 * 2 ** reconnectAttempts, CONFIG.MAX_RECONNECT_DELAY);
        setTimeout(connectWebSocket, timeout);
        reconnectAttempts++;
    };
}

// Function to validate incoming messages
function isValidMessage(msg) {
    return msg && typeof msg === 'object' && 'topic' in msg && 'event' in msg && 'payload' in msg;
}

function numberString(num) {
    return num.toString().replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ",");
}

function logTime() {
    let seconds = (Date.now() - startTime) / 1000;
    if (seconds < 60) {
        console.log(`⛏️⛏️⛏️ ${(seconds).toFixed(0)} seconds ⛏️⛏️⛏️`);
    } else {
        console.log(`⛏️⛏️⛏️ ${(seconds / 60).toFixed(1)} minutes ⛏️⛏️⛏️`);
    }
}

// Function to handle incoming messages and update visualization
function handleIncomingMessage(message) {
    const sessionSig = message.sig;

    if (wallet.key && sessionSig && message.key == wallet.key) {
        if (wallet.sig != sessionSig) {
            let particle = sessions.get(wallet.sig)?.particle;
            particle && (particle.alpha = 0);
            wallet.sig = sessionSig;
        }
    }

    if (!sessions.has(sessionSig)) {
        // Create a new session with a main particle
        const x = random(width);
        const y = random(height);
        const color = [random(205, 255), random(205, 255), random(205, 255)];

        const mainParticle = new Particle(x, y, 10, color);
        mainParticle.sig = sessionSig;
        message.key && (mainParticle.wallet = message.key);
        if (sessionSig == wallet.sig) {
            mainParticle.size = 20;
        }
        sessions.set(sessionSig, {
            particle: mainParticle,
            subParticles: []
        });
        particles.push(mainParticle);
    } else {
        // Update the session's last message time
        const session = sessions.get(sessionSig);
        session.particle.alpha = 255;
        if (message.key && !session.particle.wallet) {
            session.particle.wallet = message.key;
        }
    }

    // Handle different types of messages to create visual effects
    const session = sessions.get(sessionSig);
    switch (message.msg._hash) {
        case 'broadcast|valid|CLAIMING':
            stats.claimed += message.reward;  
            message.reward > stats.max.reward && (stats.max.reward = message.reward);
            message.boost > stats.max.boost && (stats.max.boost = message.boost); 
            createExplosion(session, message.reward, message.boost, true, [0, 255, 100]);
            break;
        case 'broadcast|valid|RUNNING':
            message.reward > stats.max.reward && (stats.max.reward = message.reward);
            message.boost > stats.max.boost && (stats.max.boost = message.boost);
            createExplosion(session, message.reward, message.boost, false, [0, 150, 255]);
            break;
        case 'broadcast|valid|EXPIRED':
            stats.expired += message.reward;
            createExplosion(session, message.reward, message.boost, true, [139, 0, 0]);
            break;
        case 'broadcast|valid|SLASHING':
            stats.slashed += message.reward;
            createExplosion(session, message.reward, message.boost, true, [255, 215, 0]);
            break;
        case 'broadcast|valid|MINING':
            createExplosion(session, message.reward, message.boost, false, [193, 72, 228]);
            break;
        case 'broadcast|valid|JOINING':
            createExplosion(session, message.reward, message.boost, false, [228, 72, 186]);
            break;
        case 'broadcast|work|peer_hash_validation':
            session.particle.hashes += 1;
            stats.hashes += 1;
            message.hashValue > stats.max.hash && (stats.max.hash = message.hashValue);
            createRecoilSubParticle(session, message.hashValue);
            break;
        case 'broadcast|claim':
            session.particle.color = [0, 255, 100];
        default:
            createSubParticle(session);
    }

    if (wallet.sig == sessionSig) {
        if (message.key && wallet.key != message.key) {
            wallet.key = message.key;
        }
        console.log(message.msg._hash);
        session.particle.wallet && console.log(`wallet: ${session.particle.wallet}`);
        session.particle.reward && console.log(`reward: ${numberString(session.particle.reward)}`);
        session.particle.boost && console.log(`boost: ${session.particle.boost}`)
        session.particle.hashes && console.log(`hashes: ${session.particle.hashes}`)
        console.log(message.msg);
        logTime();
    }
}

// Main p5.js draw loop
function draw() {
    if (isTabVisible) {
        background(0);
        translate(-width / 2, -height / 2);
    }

    // Update particles and sessions regardless of visibility
    particles = particles.filter((particle) => {
        particle.update();
        isTabVisible && particle.display();

        const session = sessions.get(particle.sig);

        if (particle.alpha <= 0 && session.subParticles.filter(subParticle => subParticle.alpha > 0).length == 0) {
            sessions.delete(particle.sig);
            return false;
        }
        return true;
    });

    // Update and display subparticles
    for (const session of sessions.values()) {
        session.subParticles = session.subParticles.filter((subParticle) => {
            subParticle.update();
            isTabVisible && subParticle.display();
            return subParticle.alpha > 0;
        });
    }
}

// Class representing a particle
class Particle {
    constructor(x, y, size, color, isSubParticle = false) {
        this.pos = createVector(x, y);
        this.size = size;
        this.color = color;
        this.alpha = 255;
        this.isSubParticle = isSubParticle;
        this.sig = null;
        this.wallet = null;
        this.reward = 0;
        this.hashes = 0;
        this.boost = 0;

        this.vel = isSubParticle
            ? p5.Vector.random2D().mult(random(0.5, 2))
            : createVector(0, 0);
        this.acc = createVector(0, 0);
        this.maxSpeed = 5;
    }

    // Applies a force to the particle
    applyForce(force) {
        this.acc.add(force);
    }

    // Updates the particle's position and alpha
    update() {
        if (this.isSubParticle) {
            this.alpha -= 6;
        } else {
            if (this.sig != wallet.sig) {
                this.alpha -= 0.05;
            } else {
                this.alpha -= 0.01;
            }
            this.vel.limit(this.maxSpeed);
        }

        this.vel.add(this.acc);
        this.pos.add(this.vel);

        this.acc.mult(0);

        if (!this.isSubParticle) {
            this.checkEdges();
        }
    }

    // Keeps the particle within canvas boundaries
    checkEdges() {
        const radius = this.size / 2;

        if (this.pos.x - radius <= 0 || this.pos.x + radius >= width) {
            this.vel.x *= -1;
            this.pos.x = constrain(this.pos.x, radius, width - radius);
        }

        if (this.pos.y - radius <= 0 || this.pos.y + radius >= height) {
            this.vel.y *= -1;
            this.pos.y = constrain(this.pos.y, radius, height - radius);
        }
    }

    // Renders the particle
    display() {
        push();
        noStroke();
        fill(...this.color, this.alpha);
        translate(this.pos.x, this.pos.y);
        ellipse(0, 0, this.size);
        pop();
    }
}

// Creates a subparticle and applies recoil to the parent particle
function createSubParticle(session) {
    const parent = session.particle;
    const subParticleSize = 5;
    const color = [random(205, 255), random(205, 255), random(205, 255)];

    const subParticle = new Particle(
        parent.pos.x,
        parent.pos.y,
        subParticleSize,
        color,
        true
    );
    isTabVisible && session.subParticles.push(subParticle);

    const recoilForce = subParticle.vel.copy().mult(-0.1);
    parent.applyForce(recoilForce);

    parent.color = color;
}

// Creates a recoil subparticle with properties based on hash value
function createRecoilSubParticle(session, hashValue) {
    const parent = session.particle;

    const subParticleSize = map(hashValue, 0, stats.max.hash, 3, 9);
    const subParticleSpeed = map(hashValue, 0, stats.max.hash, 0.5, 3);
    const color = [random(205, 255), random(205, 255), random(205, 255)];

    const subParticle = new Particle(
        parent.pos.x,
        parent.pos.y,
        subParticleSize,
        color,
        true
    );
    subParticle.vel.setMag(subParticleSpeed);
    isTabVisible && session.subParticles.push(subParticle);

    const recoilForce = subParticle.vel.copy().mult(-0.1);
    parent.applyForce(recoilForce);

    parent.color = color;
    parent.size = map(hashValue, 0, stats.max.hash, 9, 18);

    if (parent.sig == wallet.sig) {
        parent.size += 20;
    }
}

// Generates an explosion effect with multiple subparticles
function createExplosion(session, reward, boost, shouldDie, baseColor) {
    const parent = session.particle;
    parent.reward = reward;
    boost > parent.boost && (parent.boost = boost);
    const numParticles = shouldDie
        ? map(reward, 100e6, stats.max.reward, 10, 40)
        : map(reward, 100e6, stats.max.reward, 5, 20);

    const explosionSpeed = map(boost, 0, stats.max.boost, 1, 5);

    for (let i = 0; i < numParticles; i++) {
        const subParticleSize = map(boost, 0, stats.max.boost, 7, 16);

        const subParticleColor = baseColor.map((c) =>
            constrain(c + random(-20, 20), 0, 255)
        );

        const subParticle = new Particle(
            parent.pos.x,
            parent.pos.y,
            subParticleSize,
            subParticleColor,
            true
        );

        subParticle.vel.setMag(explosionSpeed);
        (isTabVisible || shouldDie) && session.subParticles.push(subParticle);

        const recoilForce = subParticle.vel.copy().mult(-0.01);
        parent.applyForce(recoilForce);
    }

    parent.color = baseColor;

    if (shouldDie) {
        parent.alpha = 0;
    }
}


// Adjust canvas size when window is resized
function windowResized() {
    resizeCanvas(windowWidth, windowHeight);
}

document.addEventListener('visibilitychange', function() {
    isTabVisible = !document.hidden;
});

function mouseClicked() {
    let mouse = createVector(mouseX, mouseY);
    let found = false;

    for (let particle of particles) {
        let _dist = p5.Vector.dist(mouse, particle.pos);
        if (_dist < particle.size / 2) {
            if (wallet.sig != particle.sig) {
                wallet.key = particle.wallet;
                let w = sessions.get(wallet.sig)?.particle;
                w && (w.size = constrain(w.size - 20, 10, 38));
            } 
            particle.size = constrain(particle.size + 20, 10, 38);
            wallet.sig = particle.sig;

            if (particle.wallet) {
                console.log(`following wallet: ${particle.wallet}`)
            } else {
                console.log(`following sig: ${particle.sig}`)
            }

            found = true;

            particle.reward && console.log('reward: ', numberString(particle.reward));
            particle.boost && console.log('boost: ', particle.boost);
            particle.hashes && console.log('hashes: ', particle.hashes);
            logTime();
            break;
        }
    }

    if (!found) {
        if (wallet.sig) {
            let particle = sessions.get(wallet.sig)?.particle;
            if (particle) {
                particle.size = constrain(particle.size - 20, 10, 38);
            }
        }

        wallet.key = null;
        wallet.sig = null;
    }
}

setInterval(() => {
    console.log(`total unclaimed: ${numberString(particles.reduce((curr, nex) => curr + nex.reward, 0) - stats.claimed)}`);
    stats.claimed && console.log(`total claimed: ${numberString(stats.claimed)}`); 
    stats.slashed && console.log(`total slashed: ${numberString(stats.slashed)}`); 
    stats.expired && console.log(`total expired: ${numberString(stats.expired)}`); 
    stats.hashes && console.log(`total hashes: ${numberString(stats.hashes)}`);
    console.log(`max boost: ${stats.max.boost}`);
    console.log(`max hash: ${stats.max.hash}`);
    console.log(`max reward: ${numberString(stats.max.reward)}`);
    console.log(`total sessions: ${particles.length}`);
    console.log(`total sessions over 100m: ${particles.filter(x => x.reward >= 100e6).length}`);
    logTime();
}, 1000 * 30);