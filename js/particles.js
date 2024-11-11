(function(app) {
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
            this.hashRate = 0;
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
                if (this.sig != app.wallet.sig) {
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
            fill(...app.defaultColors.events['ROCKET']);
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
            fill(...app.defaultColors.events['ROCKET'], this.alpha);
            ellipse(this.pos.x, this.pos.y, this.size);
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
        app.isTabVisible && session.subParticles.push(subParticle);
        const recoilForce = subParticle.vel.copy().mult(-0.1);
        parent.applyForce(recoilForce);
        parent.color = color;
    }

    function createRecoilSubParticle(session, hashValue, baseColor) {
        const parent = session.particle;
        parent.hashRate = hashValue;
        const subParticleSize = map(hashValue, 0, app.stats.max.hash, 3, 9);
        const subParticleSpeed = map(hashValue, 0, app.stats.max.hash, 0.5, 3);
        const color = baseColor;
        const subParticle = new Particle(
            parent.pos.x,
            parent.pos.y,
            subParticleSize,
            color,
            true
        );
        subParticle.vel.setMag(subParticleSpeed);
        app.isTabVisible && session.subParticles.push(subParticle);
        const recoilForce = subParticle.vel.copy().mult(-0.1);
        parent.applyForce(recoilForce);
        parent.color = color;
        parent.size = map(hashValue, 0, app.stats.max.hash, 9, 18);
        if (parent.sig == app.wallet.sig) {
            parent.size += 20;
        }
    }

    function createExplosion(session, reward, boost, shouldDie, baseColor) {
        const parent = session.particle;
        parent.reward = reward;
        boost > parent.boost && (parent.boost = boost);
        const numParticles = shouldDie
            ? map(reward, 0, app.stats.max.reward, 10, 40)
            : map(reward, 0, app.stats.max.reward, 5, 20);
        const explosionSpeed = map(boost, 0, app.stats.max.boost, 1, 5);
        for (let i = 0; i < numParticles; i++) {
            const subParticleSize = map(boost, 0, app.stats.max.boost, 7, 16);
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
            (app.isTabVisible || shouldDie) && session.subParticles.push(subParticle);
            const recoilForce = subParticle.vel.copy().mult(-0.01);
            parent.applyForce(recoilForce);
        }
        parent.color = baseColor;
        if (shouldDie) {
            parent.alpha = 0;
        }
    }

    app.shootProjectile = function() {
        let tipPos = app.ship.getTipPosition();
        const projectile = new Projectile(tipPos, app.ship.angle, app.ship.vel);
        app.projectiles.push(projectile);
    };

    app.Particle = Particle;
    app.Ship = Ship;
    app.Projectile = Projectile;
    app.createSubParticle = createSubParticle;
    app.createRecoilSubParticle = createRecoilSubParticle;
    app.createExplosion = createExplosion;

})(window.POND);
