'use strict';

const CONFIG = {
    TIMEOUT_DURATION: 300000,
    WS_URL: 'wss://vkqjvwxzsxilnsmpngmc.supabase.co/realtime/v1/websocket',
    EVENTS_PER_SECOND: 5,
    VSN: '1.0.0',
    HEARTBEAT_INTERVAL: 30000,
    MAX_RECONNECT_DELAY: 30000,
    API_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrcWp2d3h6c3hpbG5zbXBuZ21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjYwODExMjMsImV4cCI6MjA0MTY1NzEyM30.u9gf6lU2fBmf0aiC7SYH4vVeWMRnGRu4ZZ7xOGl-XuI'
};

function getWebSocketUrl() {
    const params = new URLSearchParams({
        apikey: CONFIG.API_KEY,
        eventsPerSecond: CONFIG.EVENTS_PER_SECOND,
        vsn: CONFIG.VSN,
    });
    return `${CONFIG.WS_URL}?${params.toString()}`;
}

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
        reward: 0,
        boost: 0,
        hash: 0,
    }
}

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);
const wallet = {
    key: urlParams.get('wallet'),
    sig: null
}

let showHUD = false;
let bgColorPicker, eventColorPickers = {};
let resetButton;

let hasRocket = urlParams.has('rocket');
let ship;
let projectiles = [];

let colorConfig = () => ({
    background: [0, 0, 0],
    mainParticle: [255, 255, 255],
    events: {
        HASH: [255, 255, 255],
        CLAIMING: [0, 255, 100],
        RUNNING: [0, 150, 255],
        EXPIRED: [139, 0, 0],
        SLASHING: [255, 215, 0],
        MINING: [193, 72, 228],
        JOINING: [228, 72, 186],
        ROCKET: [82, 173, 98]
    }
})

let defaultColors = colorConfig();

function loadColors() {
    let storedColors = localStorage.getItem('particleColors');
    if (storedColors) {
        storedColors = JSON.parse(storedColors);
        storedColors.mainParticle = storedColors.events.HASH.slice();
        if (!storedColors.events['ROCKET']) {
            storedColors.events['ROCKET'] = colorConfig().events['ROCKET'];
        }
        defaultColors = storedColors;
    }
}

function saveColors() {
    localStorage.setItem('particleColors', JSON.stringify(defaultColors));
}

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

function setup() {
    createCanvas(windowWidth, windowHeight, WEBGL);
    loadColors();
    bgColorPicker = createColorPicker(color(...defaultColors.background));
    bgColorPicker.position(10, 10);
    bgColorPicker.hide();
    bgColorPicker.input(() => {
        defaultColors.background = [bgColorPicker.color().levels[0], bgColorPicker.color().levels[1], bgColorPicker.color().levels[2]];
        saveColors();
    });
    bgColorPicker.attribute('title', 'Background');
    bgColorPicker.style('background-color', `transparent`);
    bgColorPicker.style('border', `transparent`);
    let yOffset = 40;
    for (let eventName in defaultColors.events) {
        if (eventName != 'ROCKET' || (eventName == 'ROCKET' && hasRocket)) {
            eventColorPickers[eventName] = createColorPicker(color(...defaultColors.events[eventName]));
            eventColorPickers[eventName].position(10, yOffset);
            eventColorPickers[eventName].hide();
            eventColorPickers[eventName].input(() => {
                let col = eventColorPickers[eventName].color();
                defaultColors.events[eventName] = [col.levels[0], col.levels[1], col.levels[2]];
                saveColors();
            });
            eventColorPickers[eventName].attribute('title', `${eventName}`);
            eventColorPickers[eventName].style('background-color', `transparent`);
            eventColorPickers[eventName].style('border', `transparent`);
            yOffset += 30;
        }
    }
    resetButton = createButton('⛏️');
    resetButton.position(12, yOffset + 4);
    resetButton.size(46, 22);
    resetButton.hide();
    resetButton.mousePressed(resetColors);
    resetButton.attribute('title', 'Reset to Default Colors');
    resetButton.style('background-color', '#2b2b2de8');
    resetButton.style('border', 'none');
    connectWebSocket();

    hasRocket = urlParams.has('rocket');
    if (hasRocket) {
        ship = new Ship();
    }
}

function resetColors() {
    defaultColors = colorConfig();
    bgColorPicker.color(color(...defaultColors.background));
    for (let eventName in eventColorPickers) {
        eventColorPickers[eventName].color(color(...defaultColors.events[eventName]));
    }
    saveColors();
}

function connectWebSocket() {
    const wsUrl = getWebSocketUrl();
    socket = new WebSocket(wsUrl);
    const messageBuilder = new MessageBuilder(CONFIG.API_KEY);
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
        const x = random(width);
        const y = random(height);
        const color = defaultColors.mainParticle.slice();
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
        const session = sessions.get(sessionSig);
        session.particle.alpha = 255;
        if (message.key && !session.particle.wallet) {
            session.particle.wallet = message.key;
        }
    }
    const session = sessions.get(sessionSig);
    switch (message.msg._hash) {
        case 'broadcast|valid|CLAIMING':
            stats.claimed += message.reward;
            message.reward > stats.max.reward && (stats.max.reward = message.reward);
            message.boost > stats.max.boost && (stats.max.boost = message.boost);
            let claimingColor = defaultColors.events['CLAIMING'].slice();
            createExplosion(session, message.reward, message.boost, true, claimingColor);
            break;
        case 'broadcast|valid|RUNNING':
            message.reward > stats.max.reward && (stats.max.reward = message.reward);
            message.boost > stats.max.boost && (stats.max.boost = message.boost);
            let runningColor = defaultColors.events['RUNNING'].slice();
            createExplosion(session, message.reward, message.boost, false, runningColor);
            break;
        case 'broadcast|valid|EXPIRED':
            stats.expired += message.reward;
            let expiredColor = defaultColors.events['EXPIRED'].slice();
            createExplosion(session, message.reward, message.boost, true, expiredColor);
            break;
        case 'broadcast|valid|SLASHING':
            stats.slashed += message.reward;
            let slashingColor = defaultColors.events['SLASHING'].slice();
            createExplosion(session, message.reward, message.boost, true, slashingColor);
            break;
        case 'broadcast|valid|MINING':
            let miningColor = defaultColors.events['MINING'].slice();
            createExplosion(session, message.reward, message.boost, false, miningColor);
            break;
        case 'broadcast|valid|JOINING':
            let joiningColor = defaultColors.events['JOINING'].slice();
            createExplosion(session, message.reward, message.boost, false, joiningColor);
            break;
        case 'broadcast|work|peer_hash_validation':
            session.particle.hashes += 1;
            stats.hashes += 1;
            message.hashValue > stats.max.hash && (stats.max.hash = message.hashValue);
            let hashValidationColor = defaultColors.events['HASH'].slice();
            createRecoilSubParticle(session, message.hashValue, hashValidationColor);
            break;
        case 'broadcast|claim':
            session.particle.color = defaultColors.events['CLAIMING'].slice();
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

function draw() {
    if (isTabVisible) {
        background(...defaultColors.background);
        translate(-width / 2, -height / 2);
    }
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
    for (const session of sessions.values()) {
        session.subParticles = session.subParticles.filter((subParticle) => {
            subParticle.update();
            isTabVisible && subParticle.display();
            return subParticle.alpha > 0;
        });
    }
    if (showHUD) {
        bgColorPicker.show();
        for (let eventName in eventColorPickers) {
            eventColorPickers[eventName].show();
        }
        resetButton.show();
    } else {
        bgColorPicker.hide();
        for (let eventName in eventColorPickers) {
            eventColorPickers[eventName].hide();
        }
        resetButton.hide();
    }

    if (hasRocket) {
        ship.update();
        isTabVisible && ship.display();

        projectiles = projectiles.filter(projectile => {
            projectile.update();
            isTabVisible && projectile.display();
            return projectile.alpha > 0;
        });

        for (let i = projectiles.length - 1; i >= 0; i--) {
            let projectile = projectiles[i];
            for (let j = particles.length - 1; j >= 0; j--) {
                let particle = particles[j];
                let distance = p5.Vector.dist(projectile.pos, particle.pos);
                if (particle.alpha > 0 && distance < (projectile.size + particle.size) / 2) {
                    let session = sessions.get(particle.sig);
                    if (session) {
                        createExplosion(session, particle.reward, particle.boost, true, [255, 0, 0]);
                    }

                    projectiles.splice(i, 1);
                    break;
                }
            }
        }

        if (keyIsDown(32) && frameCount % 7 == 0) {
            shootProjectile();
        }
    }
}

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

    applyForce(force) {
        this.acc.add(force);
    }

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

    display() {
        push();
        noStroke();
        fill(...this.color, this.alpha);
        translate(this.pos.x, this.pos.y);
        ellipse(0, 0, this.size);
        pop();
    }
}

function createSubParticle(session) {
    const parent = session.particle;
    const subParticleSize = 5;
    const color = [...parent.color];
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

function createRecoilSubParticle(session, hashValue, baseColor) {
    const parent = session.particle;
    const subParticleSize = map(hashValue, 0, stats.max.hash, 3, 9);
    const subParticleSpeed = map(hashValue, 0, stats.max.hash, 0.5, 3);
    const color = baseColor;
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

function createExplosion(session, reward, boost, shouldDie, baseColor) {
    const parent = session.particle;
    parent.reward = reward;
    boost > parent.boost && (parent.boost = boost);
    const numParticles = shouldDie
        ? map(reward, 0, stats.max.reward, 10, 40)
        : map(reward, 0, stats.max.reward, 5, 20);
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
        if (urlParams.get('wallet')) {
            wallet.key = urlParams.get('wallet');
            let particle = particles.find(x => x.wallet == wallet.key);
            if (particle) {
                wallet.sig = particle.sig;
                particle.size = constrain(particle.size + 20, 10, 38);
                console.log(`following wallet: ${particle.wallet}`)
            }
        } else {
            wallet.key = null;
            wallet.sig = null;
        }
    }
}

function keyPressed() {
    if (key === 'c' || key === 'C') {
        showHUD = !showHUD;
    }
    if (hasRocket) {
        if (keyCode === RIGHT_ARROW) {
            ship.setRotation(0.1);
        } else if (keyCode === LEFT_ARROW) {
            ship.setRotation(-0.1);
        } else if (keyCode === UP_ARROW) {
            ship.setThrusting(true);
        } else if (keyCode === 32) {
            shootProjectile();
        }
    }
}

function keyReleased() {
    if (hasRocket) {
        if (keyCode === RIGHT_ARROW || keyCode === LEFT_ARROW) {
            ship.setRotation(0);
        } else if (keyCode === UP_ARROW) {
            ship.setThrusting(false);
        }
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


class Ship {
    constructor() {
        this.pos = createVector(width / 2, height / 2);
        this.vel = createVector(0, 0);
        this.acc = createVector(0, 0);
        this.angle = 0;
        this.rotation = 0;
        this.thrusting = false;
        this.maxSpeed = 4;
        this.base = 20;
        this.height = 30;
    }

    applyForce(force) {
        this.acc.add(force);
    }

    update() {
        if (this.thrusting) {
            const force = p5.Vector.fromAngle(this.angle).mult(0.1);
            this.applyForce(force);
        }

        this.vel.add(this.acc);
        this.vel.limit(this.maxSpeed);
        this.pos.add(this.vel);
        this.acc.mult(0);

        this.angle += this.rotation;

        if (this.pos.x > width) this.pos.x = 0;
        else if (this.pos.x < 0) this.pos.x = width;
        if (this.pos.y > height) this.pos.y = 0;
        else if (this.pos.y < 0) this.pos.y = height;
    }

    display() {
        push();
        translate(this.pos.x, this.pos.y);
        rotate(this.angle + PI / 2);
        fill(...defaultColors.events['ROCKET']);
        noStroke();
        beginShape();
        vertex(0, -this.height / 2);         
        vertex(-this.base / 2, this.height / 2);
        vertex(this.base / 2, this.height / 2);
        endShape(CLOSE);
        pop();
    }

    setRotation(angle) {
        this.rotation = angle;
    }

    setThrusting(thrusting) {
        this.thrusting = thrusting;
    }

    getTipPosition() {
        let tip = p5.Vector.fromAngle(this.angle).mult((this.height / 2) - 1);
        return p5.Vector.add(this.pos, tip);
    }
}

class Projectile {
    constructor(pos, angle, shipVel) {
        this.pos = pos.copy();
        this.vel = p5.Vector.fromAngle(angle).mult(7).add(shipVel);
        this.size = 5;
        this.alpha = 255;
    }

    update() {
        this.pos.add(this.vel);
        this.alpha -= 1;
        if (this.alpha <= 0 ||
            this.pos.x < 0 || this.pos.x > width ||
            this.pos.y < 0 || this.pos.y > height) {
            this.alpha = 0;
        }
    }

    display() {
        push();
        noStroke();
        fill(...defaultColors.events['ROCKET'], this.alpha);
        ellipse(this.pos.x, this.pos.y, this.size);
        pop();
    }
}

function shootProjectile() {
    let tipPos = ship.getTipPosition();
    const projectile = new Projectile(tipPos, ship.angle, ship.vel);
    projectiles.push(projectile);
}
