"""
Options executor for placing spread orders.
"""


class OptionsExecutor:
    """Execute options spread orders."""
    
    def __init__(self, ibkr_client):
        self.ibkr = ibkr_client
    
    def place_bear_put_spread(self, spread, quantity=1):
        """Place bear put spread order (stub for now)."""
        print(f"[OPTIONS] Would place {quantity} bear put spread on {spread['symbol']}")
        print(f"  Buy {spread['upper_strike']} put / Sell {spread['lower_strike']} put")
        print(f"  Max loss: ${spread['max_loss']:.2f} | Max gain: ${spread['max_gain']:.2f}")
        return None  # Return order ID when implemented
