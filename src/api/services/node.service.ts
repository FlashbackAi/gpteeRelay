import { NodeSettingsModel, NodeSettingsUpdate } from '../models/nodeSettings.model';
import { NodesModel } from '../models/node.model';

export class NodeService {

    /**
     * GET settings — reads from node_settings_v1.
     * Also verifies the node exists in nodes_v1 to avoid returning empty data
     * for a non-existent node.
     */
    static async getNodeSettings(node_id: string) {
        // Ensure node exists
        const node = await NodesModel.getNode(node_id);
        if (!node) {
            const err: any = new Error('node_not_found');
            err.code = 'NODE_NOT_FOUND';
            throw err;
        }

        const settings = await NodeSettingsModel.getSettings(node_id);

        return {
            node_id,
            worker_mode_enabled: settings?.worker_mode_enabled ?? false,
            worker_mode_updated_at: settings?.worker_mode_updated_at ?? null,
            provider_mode_enabled: settings?.provider_mode_enabled ?? false,
            provider_mode_updated_at: settings?.provider_mode_updated_at ?? null,
            battery_threshold: settings?.battery_threshold ?? null,
            created_at: settings?.created_at ?? node.created_at,
            updated_at: settings?.updated_at ?? node.updated_at,
        };
    }

    /**
     * PUT settings — upserts into node_settings_v1.
     */
    static async updateNodeSettings(node_id: string, fields: NodeSettingsUpdate) {
        // Ensure node exists before writing settings
        const node = await NodesModel.getNode(node_id);
        if (!node) {
            const err: any = new Error('node_not_found');
            err.code = 'NODE_NOT_FOUND';
            throw err;
        }

        const updated = await NodeSettingsModel.upsertSettings(node_id, fields);

        return {
            node_id,
            worker_mode_enabled: updated.worker_mode_enabled ?? false,
            worker_mode_updated_at: updated.worker_mode_updated_at ?? null,
            provider_mode_enabled: updated.provider_mode_enabled ?? false,
            provider_mode_updated_at: updated.provider_mode_updated_at ?? null,
            battery_threshold: updated.battery_threshold ?? null,
            created_at: updated.created_at,
            updated_at: updated.updated_at,
        };
    }
}
