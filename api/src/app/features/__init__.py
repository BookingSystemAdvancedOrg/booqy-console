"""Feature modules for operator routes (CONTRACTS.md 9.3). Each module has a
`ROUTES` dict that handler.py merges into its own; a feature fills only its
own module."""

from . import google_business, meta_ads, personalliggare, phone_agent, site_builder

MODULES = (meta_ads, site_builder, google_business, personalliggare, phone_agent)
