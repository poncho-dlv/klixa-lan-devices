"""Branche les lampes sur le SDK des appareils LAN : une lampe appairée = un élément `light` dont l'identifiant est
l'uuid mesh de la lampe."""
from .lamps import FX_MODES, KELVIN_RANGE, LAMP_CAPABILITIES


def build_agent(config, lamps, agent_class=None):
    if agent_class is None:
        from klixa_device_agent import DeviceAgent as agent_class

    agent = agent_class(companion_url=config.companion_url, token=config.device_token,
                        device_id=config.device_id, name=config.device_name)
    for node in lamps.list():
        register_lamp(agent, lamps, node)
    return agent


def register_lamp(agent, lamps, node):
    uuid = node["uuid"]
    element = agent.light(uuid, name=node["name"] or uuid, capabilities=list(LAMP_CAPABILITIES),
                          kelvin=(KELVIN_RANGE["min"], KELVIN_RANGE["max"]), fx_modes=dict(FX_MODES))

    @element.set
    async def set_lamp(state, data, uuid=uuid):
        return await lamps.set_state(uuid, state)

    @element.get_state
    async def get_lamp(uuid=uuid):
        return await lamps.get_state(uuid)

    return element
