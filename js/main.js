(function(app) {
    app.socket = null;
    app.particles = [];
    app.sessions = new Map();
    app.reconnectAttempts = 0;
    app.isTabVisible = true;
    app.startTime = Date.now();

    app.stats = {
        claimed: 0,
        slashed: 0,
        expired: 0,
        hashes: 0,
        max: {
            reward: 0,
            boost: 0,
            hash: 0,
        }
    };

    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    app.wallet = {
        key: urlParams.get('wallet'),
        sig: null
    };

    app.showHUD = false;
    app.bgColorPicker = null;
    app.eventColorPickers = {};
    app.resetButton = null;

    app.hasRocket = urlParams.has('rocket');
    app.ship = null;
    app.projectiles = [];

    app.handleIncomingMessage = function(message) {
        const sessionSig = message.sig;
        if (app.wallet.key && sessionSig && message.key == app.wallet.key) {
            if (app.wallet.sig != sessionSig) {
                let particle = app.sessions.get(app.wallet.sig)?.particle;
                particle && (particle.alpha = 0);
                app.wallet.sig = sessionSig;
            }
        }
        if (!app.sessions.has(sessionSig)) {
            const x = random(width);
            const y = random(height);
            const color = app.defaultColors.mainParticle.slice();
            const mainParticle = new app.Particle(x, y, 10, color);
            mainParticle.sig = sessionSig;
            message.key && (mainParticle.wallet = message.key);
            if (sessionSig == app.wallet.sig) {
                mainParticle.size = 20;
            }
            app.sessions.set(sessionSig, {
                particle: mainParticle,
                subParticles: []
            });
            app.particles.push(mainParticle);
        } else {
            const session = app.sessions.get(sessionSig);
            session.particle.alpha = 255;
            if (message.key && !session.particle.wallet) {
                session.particle.wallet = message.key;
            }
        }
        const session = app.sessions.get(sessionSig);
        switch (message.msg._hash) {
            case 'broadcast|valid|CLAIMING':
                app.stats.claimed += message.reward;
                message.reward > app.stats.max.reward && (app.stats.max.reward = message.reward);
                message.boost > app.stats.max.boost && (app.stats.max.boost = message.boost);
                let claimingColor = app.defaultColors.events['CLAIMING'].slice();
                app.createExplosion(session, message.reward, message.boost, true, claimingColor);
                break;
            case 'broadcast|valid|RUNNING':
                message.reward > app.stats.max.reward && (app.stats.max.reward = message.reward);
                message.boost > app.stats.max.boost && (app.stats.max.boost = message.boost);
                let runningColor = app.defaultColors.events['RUNNING'].slice();
                app.createExplosion(session, message.reward, message.boost, false, runningColor);
                break;
            case 'broadcast|valid|EXPIRED':
                app.stats.expired += message.reward;
                let expiredColor = app.defaultColors.events['EXPIRED'].slice();
                app.createExplosion(session, message.reward, message.boost, true, expiredColor);
                break;
            case 'broadcast|valid|SLASHING':
                app.stats.slashed += message.reward;
                let slashingColor = app.defaultColors.events['SLASHING'].slice();
                app.createExplosion(session, message.reward, message.boost, true, slashingColor);
                break;
            case 'broadcast|valid|MINING':
                let miningColor = app.defaultColors.events['MINING'].slice();
                app.createExplosion(session, message.reward, message.boost, false, miningColor);
                break;
            case 'broadcast|valid|JOINING':
                let joiningColor = app.defaultColors.events['JOINING'].slice();
                app.createExplosion(session, message.reward, message.boost, false, joiningColor);
                break;
            case 'broadcast|work|peerjoin':
                let peerJoinColor = app.defaultColors.events['JOINING'].slice();
                app.createExplosion(session, 0, 0, false, peerJoinColor);
                break;
            case 'broadcast|work|peer_hash_validation':
                session.particle.hashes += 1;
                app.stats.hashes += 1;
                message.hashValue > app.stats.max.hash && (app.stats.max.hash = message.hashValue);
                let hashValidationColor = app.defaultColors.events['HASH'].slice();
                app.createRecoilSubParticle(session, message.hashValue, hashValidationColor);
                break;
            case 'broadcast|claim':
                session.particle.color = app.defaultColors.events['CLAIMING'].slice();
            default:
                app.createSubParticle(session);
        }
        if (app.wallet.sig == sessionSig) {
            if (message.key && app.wallet.key != message.key) {
                app.wallet.key = message.key;
            }
            console.log(message.msg._hash);
            session.particle.wallet && console.log(`wallet: ${session.particle.wallet}`);
            session.particle.reward && console.log(`reward: ${app.numberString(session.particle.reward)}`);
            session.particle.boost && console.log(`boost: ${session.particle.boost}`);
            session.particle.hashes && console.log(`hashes: ${session.particle.hashes}`);
            console.log(message.msg);
            app.logTime();
        }
    };

    function setup() {
        createCanvas(windowWidth, windowHeight, WEBGL);
        app.loadColors();
        app.setupUI();
        app.connectWebSocket();

        if (app.hasRocket) {
            app.ship = new app.Ship();
        }
    }

    function draw() {
        if (app.isTabVisible) {
            background(...app.defaultColors.background);
            translate(-width / 2, -height / 2);
        }

        app.particles = app.particles.filter((particle) => {
            particle.update();
            if (app.isTabVisible) {
                particle.display();
            }
            const session = app.sessions.get(particle.sig);
            if (particle.alpha <= 0 && session.subParticles.filter(sub => sub.alpha > 0).length == 0) {
                app.sessions.delete(particle.sig);
                return false;
            }
            return true;
        });

        for (const session of app.sessions.values()) {
            session.subParticles = session.subParticles.filter((subParticle) => {
                subParticle.update();
                if (app.isTabVisible) {
                    subParticle.display();
                }
                return subParticle.alpha > 0;
            });
        }

        if (app.showHUD) {
            app.bgColorPicker.show();
            for (let eventName in app.eventColorPickers) {
                app.eventColorPickers[eventName].show();
            }
            app.resetButton.show();
        } else {
            app.bgColorPicker.hide();
            for (let eventName in app.eventColorPickers) {
                app.eventColorPickers[eventName].hide();
            }
            app.resetButton.hide();
        }

        if (app.hasRocket && app.ship) {
            app.ship.update();
            if (app.isTabVisible) {
                app.ship.display();
            }

            app.projectiles = app.projectiles.filter(projectile => {
                projectile.update();
                if (app.isTabVisible) {
                    projectile.display();
                }
                return projectile.alpha > 0;
            });

            for (let i = app.projectiles.length - 1; i >= 0; i--) {
                let projectile = app.projectiles[i];
                for (let j = app.particles.length - 1; j >= 0; j--) {
                    let particle = app.particles[j];
                    let distance = p5.Vector.dist(projectile.pos, particle.pos);
                    if (particle.alpha > 0 && distance < (projectile.size + particle.size) / 2) {
                        let session = app.sessions.get(particle.sig);
                        if (session) {
                            app.createExplosion(session, particle.reward, particle.boost, true, [255, 0, 0]);
                        }

                        app.projectiles.splice(i, 1);
                        break;
                    }
                }
            }

            if (keyIsDown(32) && frameCount % 7 === 0) {
                app.shootProjectile();
            }
        }
    }

    function windowResized() {
        resizeCanvas(windowWidth, windowHeight);
    }

    document.addEventListener('visibilitychange', function () {
        app.isTabVisible = !document.hidden;
    });

    function mouseClicked() {
        if (!app.showHUD) {
            let mouse = createVector(mouseX, mouseY);
            let found = false;
            for (let particle of app.particles) {
                let _dist = p5.Vector.dist(mouse, particle.pos);
                if (_dist < particle.size / 2) {
                    if (app.wallet.sig != particle.sig) {
                        app.wallet.key = particle.wallet;
                        let w = app.sessions.get(app.wallet.sig)?.particle;
                        w && (w.size = constrain(w.size - 20, 10, 38));
                    }
                    particle.size = constrain(particle.size + 20, 10, 38);
                    app.wallet.sig = particle.sig;
                    if (particle.wallet) {
                        console.log(`following wallet: ${particle.wallet}`)
                    } else {
                        console.log(`following sig: ${particle.sig}`)
                    }
                    found = true;
                    particle.reward && console.log('reward: ', app.numberString(particle.reward));
                    particle.boost && console.log('boost: ', particle.boost);
                    particle.hashes && console.log('hashes: ', particle.hashes);
                    app.logTime();
                    break;
                }
            }
            if (!found) {
                if (app.wallet.sig) {
                    let particle = app.sessions.get(app.wallet.sig)?.particle;
                    if (particle) {
                        particle.size = constrain(particle.size - 20, 10, 38);
                    }
                }
                if (app.wallet.key) {
                    let particle = app.particles.find(x => x.wallet == app.wallet.key);
                    if (particle) {
                        app.wallet.sig = particle.sig;
                        particle.size = constrain(particle.size + 20, 10, 38);
                        console.log(`following wallet: ${particle.wallet}`)
                    }
                } else {
                    app.wallet.key = null;
                    app.wallet.sig = null;
                }
            }
        }
    }

    function keyPressed() {
        if (key === 'c' || key === 'C') {
            app.showHUD = !app.showHUD;
        }
        if (app.hasRocket && app.ship) {
            if (keyCode === RIGHT_ARROW) {
                app.ship.setRotation(0.1);
            } else if (keyCode === LEFT_ARROW) {
                app.ship.setRotation(-0.1);
            } else if (keyCode === UP_ARROW) {
                app.ship.setThrusting(true);
            } else if (keyCode === 32) {
                app.shootProjectile();
            }
        }
    }

    function keyReleased() {
        if (app.hasRocket && app.ship) {
            if (keyCode === RIGHT_ARROW || keyCode === LEFT_ARROW) {
                app.ship.setRotation(0);
            } else if (keyCode === UP_ARROW) {
                app.ship.setThrusting(false);
            }
        }
    }

    function setupLogging() {
        setInterval(() => {
            console.log(`total unclaimed: ${app.numberString(app.particles.reduce((curr, nex) => curr + nex.reward, 0).toFixed(0))}`);
            app.stats.claimed && console.log(`total claimed: ${app.numberString(app.stats.claimed.toFixed(0))}`);
            app.stats.slashed && console.log(`total slashed: ${app.numberString(app.stats.slashed.toFixed(0))}`);
            app.stats.expired && console.log(`total expired: ${app.numberString(app.stats.expired.toFixed(0))}`);
            app.stats.hashes && console.log(`total hashes: ${app.numberString(app.stats.hashes)}`);
            console.log(`max boost: ${app.stats.max.boost.toFixed(1)}`);
            console.log(`max hash: ${app.stats.max.hash.toFixed(1)}`);
            console.log(`max reward: ${app.numberString(app.stats.max.reward.toFixed(0))}`);
            console.log(`total sessions: ${app.particles.length}`);
            console.log(`total sessions over 100m: ${app.particles.filter(x => x.reward >= 100e6).length}`);

            let sumHash = app.particles.reduce((curr, next) => curr + next.hashRate, 0);
            let sumBoost = app.particles.reduce((curr, next) => curr + next.boost, 0);
            let sumReward = app.particles.reduce((curr, next) => curr + next.reward, 0);

            console.log(`avg boost: ${((sumBoost / app.particles.length) || 0).toFixed(1)}`);
            console.log(`avg hash: ${((sumHash / app.particles.length) || 0).toFixed(1)}`);
            console.log(`avg reward: ${app.numberString(((sumReward / app.particles.length) || 0).toFixed(0))}`);
            app.logTime();
        }, 1000 * 30);
    }

    function initialize() {
        setup();
        setupLogging();
    }

    window.setup = initialize;
    window.draw = app.draw = draw;
    window.windowResized = app.windowResized = windowResized;
    window.mouseClicked = app.mouseClicked = mouseClicked;
    window.keyPressed = app.keyPressed = keyPressed;
    window.keyReleased = app.keyReleased = keyReleased;

})(window.POND);
