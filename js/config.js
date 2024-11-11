(function(app) {
    app.CONFIG = {
        TIMEOUT_DURATION: 300000,
        WS_URL: 'wss://vkqjvwxzsxilnsmpngmc.supabase.co/realtime/v1/websocket',
        EVENTS_PER_SECOND: 5,
        VSN: '1.0.0',
        HEARTBEAT_INTERVAL: 30000,
        MAX_RECONNECT_DELAY: 30000,
        API_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZrcWp2d3h6c3hpbG5zbXBuZ21jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjYwODExMjMsImV4cCI6MjA0MTY1NzEyM30.u9gf6lU2fBmf0aiC7SYH4vVeWMRnGRu4ZZ7xOGl-XuI'
    };
})(window.PondStream);
