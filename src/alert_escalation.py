"""
Alert escalation for critical trading events.
Sends SMS/email for circuit breaker, latency issues, or major losses.
"""
import smtplib
import os
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Literal

AlertType = Literal["CIRCUIT_BREAKER", "LATENCY", "MAJOR_LOSS", "CONNECTION_LOST"]


class AlertEscalation:
    """Send critical alerts via email/SMS."""
    
    def __init__(self):
        self.email_enabled = os.getenv("ALERT_EMAIL_ENABLED", "false").lower() == "true"
        self.smtp_server = os.getenv("SMTP_SERVER", "smtp.gmail.com")
        self.smtp_port = int(os.getenv("SMTP_PORT", "587"))
        self.sender_email = os.getenv("ALERT_SENDER_EMAIL", "")
        self.sender_password = os.getenv("ALERT_SENDER_PASSWORD", "")
        self.recipient_email = os.getenv("ALERT_RECIPIENT_EMAIL", "")
        
        # SMS via email gateway (e.g., 1234567890@txt.att.net)
        self.sms_email = os.getenv("ALERT_SMS_EMAIL", "")
        
        self.alerts_sent = set()  # Prevent spam
    
    def send_alert(self, alert_type: AlertType, message: str, details: dict = None):
        """Send alert via email/SMS."""
        if not self.email_enabled or not self.sender_email:
            print(f"⚠️  ALERT [{alert_type}]: {message}")
            return
        
        # Prevent duplicate alerts within session
        alert_key = f"{alert_type}:{message[:50]}"
        if alert_key in self.alerts_sent:
            return
        
        subject = f"🚨 Trading Bot Alert: {alert_type}"
        body = f"{message}\n\n"
        
        if details:
            body += "Details:\n"
            for key, value in details.items():
                body += f"  {key}: {value}\n"
        
        try:
            # Send email
            if self.recipient_email:
                self._send_email(subject, body, self.recipient_email)
            
            # Send SMS (shorter message)
            if self.sms_email:
                sms_body = f"{alert_type}: {message[:100]}"
                self._send_email(subject, sms_body, self.sms_email)
            
            self.alerts_sent.add(alert_key)
            print(f"✅ Alert sent: {alert_type}")
            
        except Exception as e:
            print(f"❌ Failed to send alert: {e}")
    
    def _send_email(self, subject: str, body: str, recipient: str):
        """Send email via SMTP."""
        msg = MIMEMultipart()
        msg['From'] = self.sender_email
        msg['To'] = recipient
        msg['Subject'] = subject
        msg.attach(MIMEText(body, 'plain'))
        
        with smtplib.SMTP(self.smtp_server, self.smtp_port) as server:
            server.starttls()
            server.login(self.sender_email, self.sender_password)
            server.send_message(msg)
    
    def alert_circuit_breaker(self, loss_pct: float, balance: float):
        """Alert when circuit breaker triggers."""
        self.send_alert(
            "CIRCUIT_BREAKER",
            f"Circuit breaker triggered! Daily loss: {loss_pct:.2f}%",
            {"Current Balance": f"${balance:,.2f}", "Action": "All trading stopped"}
        )
    
    def alert_latency(self, loop_time: float):
        """Alert when loop execution is too slow."""
        self.send_alert(
            "LATENCY",
            f"High latency detected: {loop_time:.1f}s per loop",
            {"Threshold": "10s", "Action": "Check system resources"}
        )
    
    def alert_major_loss(self, symbol: str, loss_pct: float, loss_amount: float):
        """Alert on single position loss > 5%."""
        if abs(loss_pct) > 5:
            self.send_alert(
                "MAJOR_LOSS",
                f"Major loss on {symbol}: {loss_pct:.2f}%",
                {"Loss Amount": f"${loss_amount:,.2f}", "Symbol": symbol}
            )
    
    def alert_connection_lost(self, broker: str):
        """Alert when broker connection lost."""
        self.send_alert(
            "CONNECTION_LOST",
            f"Lost connection to {broker}",
            {"Action": "Reconnecting...", "Broker": broker}
        )
