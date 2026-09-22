# Legacy ioBroker cloud experiment

These scripts represent the original cloud-MQTT investigation. They are not the
verified local ring detector used by the self-hosted stack. In particular, the
assumed MQTT payload `{"action":"ring"}` remains unconfirmed on the tested
AVL20P firmware.

The legacy actuator handler has intentionally been removed. The verified test
required accepting the matching SIP call before publishing `OPEN DOOR`.
