(function(app) {
    app.isValidMessage = function(msg) {
        return msg && typeof msg === 'object' && 'topic' in msg && 'event' in msg && 'payload' in msg;
    };

    app.numberString = function(num) {
        return num.toString().replace(/\B(?<!\.\d*)(?=(\d{3})+(?!\d))/g, ",");
    };

    app.logTime = function() {
        let seconds = (Date.now() - app.startTime) / 1000;
        if (seconds < 60) {
            console.log(`⛏️⛏️⛏️ ${(seconds).toFixed(0)} seconds ⛏️⛏️⛏️`);
        } else {
            console.log(`⛏️⛏️⛏️ ${(seconds / 60).toFixed(1)} minutes ⛏️⛏️⛏️`);
        }
    };
})(window.PondStream);
