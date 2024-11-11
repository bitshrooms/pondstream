(function(app) {
    function loadColors() {
        let storedColors = localStorage.getItem('particleColors');
        if (storedColors) {
            storedColors = JSON.parse(storedColors);
            storedColors.mainParticle = storedColors.events.HASH.slice();
            if (!storedColors.events['ROCKET']) {
                storedColors.events['ROCKET'] = app.colorConfig().events['ROCKET'];
            }
            app.defaultColors = storedColors;
        } else {
            app.defaultColors = app.colorConfig();
        }
    }

    function saveColors() {
        localStorage.setItem('particleColors', JSON.stringify(app.defaultColors));
    }

    function resetColors() {
        app.defaultColors = app.colorConfig();
        app.bgColorPicker.color(color(...app.defaultColors.background));
        for (let eventName in app.eventColorPickers) {
            app.eventColorPickers[eventName].color(color(...app.defaultColors.events[eventName]));
        }
        saveColors();
    }

    app.colorConfig = function() {
        return {
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
        };
    };

    function setupUI() {
        app.bgColorPicker = createColorPicker(color(...app.defaultColors.background));
        app.bgColorPicker.position(10, 10);
        app.bgColorPicker.hide();
        app.bgColorPicker.input(() => {
            app.defaultColors.background = [
                app.bgColorPicker.color().levels[0],
                app.bgColorPicker.color().levels[1],
                app.bgColorPicker.color().levels[2]
            ];
            saveColors();
        });
        app.bgColorPicker.attribute('title', 'Background');
        app.bgColorPicker.style('background-color', `transparent`);
        app.bgColorPicker.style('border', `transparent`);

        let yOffset = 40;
        app.eventColorPickers = {};

        for (let eventName in app.defaultColors.events) {
            if (eventName !== 'ROCKET' || (eventName === 'ROCKET' && app.hasRocket)) {
                app.eventColorPickers[eventName] = createColorPicker(color(...app.defaultColors.events[eventName]));
                app.eventColorPickers[eventName].position(10, yOffset);
                app.eventColorPickers[eventName].hide();
                app.eventColorPickers[eventName].input(() => {
                    let col = app.eventColorPickers[eventName].color();
                    app.defaultColors.events[eventName] = [col.levels[0], col.levels[1], col.levels[2]];
                    saveColors();
                });
                app.eventColorPickers[eventName].attribute('title', `${eventName}`);
                app.eventColorPickers[eventName].style('background-color', `transparent`);
                app.eventColorPickers[eventName].style('border', `transparent`);
                yOffset += 30;
            }
        }

        app.resetButton = createButton('⛏️');
        app.resetButton.position(12, yOffset + 4);
        app.resetButton.size(46, 22);
        app.resetButton.hide();
        app.resetButton.mousePressed(resetColors);
        app.resetButton.attribute('title', 'Reset to Default Colors');
        app.resetButton.style('background-color', '#2b2b2de8');
        app.resetButton.style('border', 'none');
    }

    app.loadColors = loadColors;
    app.saveColors = saveColors;
    app.resetColors = resetColors;
    app.setupUI = setupUI;

})(window.PondStream);
