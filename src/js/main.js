/*
 * Copyright (c) 2013-2017 CoNWeT Lab., Universidad Politécnica de Madrid
 * Copyright (c) 2019-2020 Future Internet Consulting and Development Solutions S.L.
 * Copyright (c) 2020-2023 Kazuhito Suda
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* globals MashupPlatform, moment, NGSI */

(function () {

    "use strict";

    /* *****************************************************************************/
    /* ******************************** PUBLIC *************************************/
    /* *****************************************************************************/

    var NGSISource = function NGSISource() {
        this.connection = null; // The connection to NGSI.
        this.refresh_interval = null;
        this.query_task = null;
    };

    NGSISource.prototype.init = function init() {
        // Set preference callbacks
        MashupPlatform.prefs.registerCallback(handlerPreferences.bind(this));

        // Set beforeunload listener
        window.addEventListener("beforeunload", () => {
            if (this.query_task != null) {
                this.query_task.abort(null, true);
                this.query_task = null;
            }

            if (this.subscriptionId == null) {
                return;
            }

            this.connection.v2.deleteSubscription(this.subscriptionId).then(
                () => {
                    MashupPlatform.operator.log("Subscription cancelled sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error cancelling current context broker subscription");
                }
            );
        });

        // Set wiring status callback
        MashupPlatform.wiring.registerStatusCallback(() => {
            if (this.connection == null) {
                doInitialSubscription.call(this);
            }
        });

        if (!MashupPlatform.operator.inputs.ngsimetadataInput.connected) {
            // Create NGSI conection
            doInitialSubscription.call(this);

            // Initial sent of configs on metadata output endpoint
            sendMetadata();
        }

        // Set NGSI metadata input callbacks
        MashupPlatform.wiring.registerCallback("ngsimetadataInput", entities => {
            handlerNgsiMetadataInput.call(this, entities);
        });
    };

    /* *****************************************************************************/
    /* ******************************** PRIVATE ************************************/
    /* *****************************************************************************/

    var doInitialSubscription = function doInitialSubscription() {

        this.subscriptionId = null;
        this.connection = null;

        if (!MashupPlatform.operator.outputs.entityOutput.connected && !MashupPlatform.operator.outputs.normalizedOutput.connected) {
            return;
        }

        this.ngsi_server = MashupPlatform.prefs.get('ngsi_server');
        this.ngsi_proxy = MashupPlatform.prefs.get('ngsi_proxy');

        var request_headers = {};

        if (MashupPlatform.prefs.get('use_owner_credentials')) {
            request_headers['FIWARE-OAuth-Token'] = 'true';
            request_headers['FIWARE-OAuth-Header-Name'] = 'X-Auth-Token';
            request_headers['FIWARE-OAuth-Source'] = 'workspaceowner';
        }

        var tenant = MashupPlatform.prefs.get('ngsi_tenant').trim();
        if (tenant !== '') {
            request_headers['FIWARE-Service'] = tenant;
        }

        var path = MashupPlatform.prefs.get('ngsi_service_path').trim();
        if (path !== '' && path !== '/') {
            request_headers['FIWARE-ServicePath'] = path;
        }

        this.connection = new NGSI.Connection(this.ngsi_server, {
            use_user_fiware_token: MashupPlatform.prefs.get('use_user_fiware_token'),
            request_headers: request_headers,
            ngsi_proxy_url: this.ngsi_proxy
        });

        var types = MashupPlatform.prefs.get('ngsi_entities').trim().replace(/,+\s+/g, ',');
        if (types === '') {
            types = undefined;
        }

        var id_pattern = MashupPlatform.prefs.get('ngsi_id_filter').trim();
        if (id_pattern === '') {
            id_pattern = '.*';
        }

        var filter = MashupPlatform.prefs.get('query').trim();
        var attrs = MashupPlatform.prefs.get('ngsi_update_attributes').trim();
        if (filter === '') {
            filter = undefined;
        }

        var condition = undefined;
        if (filter != null || attrs !== "") {
            condition = {};
        }
        if (attrs !== "") {
            condition.attrs = attrs.split(new RegExp(',\\s*'));
        }
        if (filter != null) {
            condition.expression = {
                q: filter
            };
        }

        if (attrs === "") {
            doInitialQueries.call(this, id_pattern, types, filter);
        } else {
            var entities = [];
            if (types != null) {
                entities = types.split(',').map((type) => {
                    return {
                        idPattern: id_pattern,
                        type: type
                    };
                });
            } else {
                entities.push({idPattern: id_pattern});
            }

            let attrsFormat = MashupPlatform.operator.outputs.normalizedOutput.connected ? "normalized" : "keyValues";
            this.connection.v2.createSubscription({
                description: "ngsi source subscription",
                subject: {
                    entities: entities,
                    condition: condition
                },
                notification: {
                    attrsFormat: attrsFormat,
                    callback: (notification) => {
                        handlerReceiveEntities.call(this, attrsFormat, notification.data);
                    }
                },
                expires: moment().add('3', 'hours').toISOString()
            }, {
                skipInitialNotification: true
            }).then(
                (response) => {
                    MashupPlatform.operator.log("Subscription created successfully (id: " + response.subscription.id + ")", MashupPlatform.log.INFO);
                    this.subscriptionId = response.subscription.id;
                    this.refresh_interval = setInterval(refreshNGSISubscription.bind(this), 1000 * 60 * 60 * 2);  // each 2 hours
                    doInitialQueries.call(this, id_pattern, types, filter);
                },
                (e) => {
                    if (e instanceof NGSI.ProxyConnectionError) {
                        MashupPlatform.operator.log("Error connecting with the NGSI Proxy: " + e.cause.message);
                    } else {
                        MashupPlatform.operator.log("Error creating subscription in the context broker server: " + e.message);
                    }
                }
            );
        }
    };

    var refreshNGSISubscription = function refreshNGSISubscription() {
        if (this.subscriptionId) {
            this.connection.v2.updateSubscription({
                id: this.subscriptionId,
                expires: moment().add('3', 'hours').toISOString()
            }).then(
                () => {
                    MashupPlatform.operator.log("Subscription refreshed sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error refreshing current context broker subscription");
                }
            );
        }
    };

    var buffering = MashupPlatform.prefs.get('buffering');
    var buffer = [];

    var requestInitialData = function requestInitialData(idPattern, types, filter, attrsFormat, page) {
        return this.connection.v2.listEntities(
            {
                idPattern: idPattern,
                type: types,
                count: true,
                keyValues: attrsFormat === "keyValues",
                limit: 100,
                offset: page * 100,
                q: filter
            }
        ).then(
            (response) => {
                if (buffering) {
                    buffer = buffer.concat(response.results);
                } else {
                    handlerReceiveEntities.call(this, attrsFormat, response.results);
                }
                if (page < 100 && (page + 1) * 100 < response.count) {
                    return requestInitialData.call(this, idPattern, types, filter, attrsFormat, page + 1);
                } else {
                    if (buffering) {
                        handlerReceiveEntities.call(this, attrsFormat, buffer);
                        buffer = [];
                    }
                }
            },
            () => {
                MashupPlatform.operator.log("Error retrieving initial values");
            }
        );
    };

    var doInitialQueries = function doInitialQueries(idPattern, types, filter) {
        let attrsFormat = MashupPlatform.operator.outputs.normalizedOutput.connected ? "normalized" : "keyValues";
        this.query_task = requestInitialData.call(this, idPattern, types, filter, attrsFormat, 0);
    };

    const normalize2KeyValue = function normalize2KeyValue(entity) {
        // Transform to keyValue
        let result = {};
        for (let key in entity) {
            let at = entity[key];
            if (key === "id" || key === "type") {
                result[key] = at;
            } else {
                result[key] = at.value;
            }
        }
        return result;
    };

    var handlerReceiveEntities = function handlerReceiveEntities(format, elements) {
        if (MashupPlatform.operator.outputs.entityOutput.connected && format === "keyValues") {
            MashupPlatform.wiring.pushEvent("entityOutput", elements);
        } else if (MashupPlatform.operator.outputs.entityOutput.connected) {
            MashupPlatform.wiring.pushEvent("entityOutput", elements.map(normalize2KeyValue));
        }
        if (MashupPlatform.operator.outputs.normalizedOutput && format === "normalized") {
            MashupPlatform.wiring.pushEvent("normalizedOutput", elements);
        }
    };

    /* *************************** Preference Handler *****************************/

    var handlerPreferences = function handlerPreferences(new_values) {

        sendMetadata();

        if (this.refresh_interval) {
            clearInterval(this.refresh_interval);
            this.refresh_interval = null;
        }

        if (this.query_task != null) {
            this.query_task.abort(null, true);
            this.query_task = null;
        }

        if (this.subscriptionId != null) {
            this.connection.v2.deleteSubscription(this.subscriptionId).then(
                () => {
                    MashupPlatform.operator.log("Old subscription has been cancelled sucessfully", MashupPlatform.log.INFO);
                },
                () => {
                    MashupPlatform.operator.log("Error cancelling old subscription", MashupPlatform.log.WARN);
                }
            ).finally(() => {
                doInitialSubscription.call(this);
            });
            // Remove subscriptionId without waiting to know if the operator finished successfully
            this.subscriptionId = null;
        } else {
            doInitialSubscription.call(this);
        }
    };

    var sendMetadata = function sendMetadata() {
        if (MashupPlatform.operator.outputs.ngsimetadata.connected) {
            var metadata = {
                types: MashupPlatform.prefs.get('ngsi_entities').trim().split(","),
                filteredAttributes: "",  // This widget does not have such information
                updateAttributes: MashupPlatform.prefs.get('ngsi_update_attributes').trim().split(","),
                // entity: response.result.entity, // For future support of fiware-ngsi-registry
                auth_type: "",  // Not present in NGSI-source
                idPattern: MashupPlatform.prefs.get('ngsi_id_filter').trim(),
                query: MashupPlatform.prefs.get('query').trim(),
                values: false, // Not needed in NGSI-source
                serverURL: MashupPlatform.prefs.get('ngsi_server').trim(),
                proxyURL: MashupPlatform.prefs.get('ngsi_proxy').trim(),
                servicePath: MashupPlatform.prefs.get('ngsi_service_path').trim(),
                tenant: MashupPlatform.prefs.get('ngsi_tenant').trim(),
                // use_owner_credentials: false,
                // use_user_fiware_token: false,
            };
            MashupPlatform.wiring.pushEvent('ngsimetadata', metadata);
        }
    }

    /* *************************** NGSI Metadata Input Hander *********************/

    var metadataTable = [
        { key: 'serverURL', pref: 'ngsi_server' },
        { key: 'proxyURL', pref: 'ngsi_proxy' },
        { key: 'use_user_fiware_token', pref: 'use_user_fiware_token' },
        { key: 'use_owner_credentials', pref: 'use_owner_credentials' },
        { key: 'tenant', pref: 'ngsi_tenant' },
        { key: 'servicePath', pref: 'ngsi_service_path' },
        { key: 'types', pref: 'ngsi_entities' },
        { key: 'idPattern', pref: 'ngsi_id_filter' },
        { key: 'query', pref: 'query' },
        { key: 'updateAttributes', pref: 'ngsi_update_attributes' }
    ];

    var handlerNgsiMetadataInput = function handlerNgsiMetadataInput(metadata) {
        if (metadata == null) {

            if (MashupPlatform.operator.outputs.entityOutput.connected) {
                MashupPlatform.wiring.pushEvent("entityOutput", null);
            }

            if (MashupPlatform.operator.outputs.normalizedOutput.connected) {
                MashupPlatform.wiring.pushEvent("handlerNgsiMetadataInput", null);
            }

            return;
        }

        metadataTable.forEach(data => {
            if (metadata[data.key] != null) {
                MashupPlatform.prefs.set(data.pref, metadata[data.key]);
            }
        });

        /*
        if (this.connection == null) {
            doInitialSubscription.call(this);
        }

        sendMetadata();
        */
        handlerPreferences.call(this);
    }

    /* import-block */
    window.NGSISource = NGSISource;
    window.refreshNGSISubscription = refreshNGSISubscription;
    /* end-import-block */

    var ngsiSource = new NGSISource();
    window.addEventListener("DOMContentLoaded", ngsiSource.init.bind(ngsiSource), false);

})();
