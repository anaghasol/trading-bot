#!/usr/bin/env python3
"""
Discord Webhook Listener - Get notified when gurus post
Requires: Discord mobile app with notifications enabled
"""
import discord
from discord.ext import commands
import os
from dotenv import load_dotenv
import re

load_dotenv()

# Your Discord bot token (from your own bot, not guru's server)
TOKEN = os.getenv('DISCORD_TOKEN')

# Channels to monitor (get IDs from Discord)
GURU_CHANNELS = [
    1314582040179376138,  # options-trade-alerts
    1299112758914056262,  # edge-quick-picks
    1224447649650835456,  # quick-picks
]

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix='!', intents=intents)

@bot.event
async def on_ready():
    print(f'✅ Monitoring Discord channels for trade alerts')
    print(f'📱 Make sure Discord mobile notifications are ON')

@bot.event
async def on_message(message):
    """Listen for trade alerts from gurus"""
    
    # Ignore own messages
    if message.author == bot.user:
        return
    
    # Only monitor specific channels
    if message.channel.id not in GURU_CHANNELS:
        return
    
    # Check if message contains stock symbols
    content = message.content.upper()
    
    # Look for stock symbols (1-5 capital letters)
    symbols = re.findall(r'\b[A-Z]{1,5}\b', content)
    
    # Filter out common words
    exclude = ['THE', 'AND', 'OR', 'BUT', 'FOR', 'WITH', 'FROM', 'TO', 'IN', 'ON', 'AT', 'BY']
    symbols = [s for s in symbols if s not in exclude]
    
    if symbols:
        print(f"\n🚨 TRADE ALERT from {message.author.name}")
        print(f"📝 {content}")
        print(f"🎯 Symbols: {', '.join(symbols)}")
        print(f"⏰ {message.created_at}")
        print(f"\n💡 To execute: python manual_discord_monitor.py")
        print("=" * 60)

if __name__ == '__main__':
    if not TOKEN:
        print("❌ DISCORD_TOKEN not found in .env")
        print("Create your own Discord bot at: https://discord.com/developers/applications")
    else:
        bot.run(TOKEN)
