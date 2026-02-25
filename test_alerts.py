"""
Test alert escalation system to verify email/SMS delivery.
Run this in paper mode to ensure alerts work before live trading.
"""
from src.alert_escalation import AlertEscalation


def test_alerts():
    """Test all alert types."""
    print("🧪 Testing Alert Escalation System\n")
    
    alert = AlertEscalation()
    
    if not alert.email_enabled:
        print("⚠️  Alerts disabled. Enable in .env:")
        print("   ALERT_EMAIL_ENABLED=true")
        print("   ALERT_SENDER_EMAIL=your-email@gmail.com")
        print("   ALERT_SENDER_PASSWORD=your-app-password")
        print("   ALERT_RECIPIENT_EMAIL=your-email@gmail.com")
        print("   ALERT_SMS_EMAIL=1234567890@txt.att.net")
        return
    
    print("Testing alerts (check your email/SMS)...\n")
    
    # Test 1: Circuit Breaker
    print("1. Testing circuit breaker alert...")
    alert.alert_circuit_breaker(loss_pct=-2.1, balance=97900)
    
    # Test 2: Latency
    print("2. Testing latency alert...")
    alert.alert_latency(loop_time=12.5)
    
    # Test 3: Major Loss
    print("3. Testing major loss alert...")
    alert.alert_major_loss(symbol="TSLA", loss_pct=-6.2, loss_amount=-620)
    
    # Test 4: Connection Lost
    print("4. Testing connection lost alert...")
    alert.alert_connection_lost(broker="IBKR")
    
    print("\n✅ Test complete. Check your email/SMS for 4 alerts.")
    print("   If you didn't receive them, verify .env settings.")


if __name__ == '__main__':
    test_alerts()
