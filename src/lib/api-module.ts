import path from "path";
import { isGatsbyConfig, isProjectMetaFn } from "@util/type-util";
import { preferDefault } from "@util/node";
import { resolveFilePath } from "@util/fs-tools";

import { processPluginCache } from "./process-plugins";

// @lib/project imports this module, so this needs to stay `type`
import type { Project } from "@lib/project";
import type { GatsbyTsPluginOptions } from "@/gatsby-plugin/types";
import type {
    InitValue,
    ProjectPluginModule,
    ProjectMetaFn,
    TranspilerReturn,
    ApiType,
} from "@typeDefs";

interface IProcessApiModuleOptions<T extends Project> {
    init: InitValue;
    project: T;
    recurse?: boolean;
}

export type ApiModuleProcessor = typeof processApiModule;

let pluginInserted = false;

export const processApiModule = <T extends Project>({
    init,
    project,
    recurse = true,
}: IProcessApiModuleOptions<T>): ProjectPluginModule<T> => {
    const projectRoot = project.projectRoot;
    const apiType = project.apiType;

    const apiDebug = project.debug.new("processApiModule");

    /**
     * This api module has already been processed once. No need to do it again.
     * Just return the last result.
     */
    if (project.finalized) {
        apiDebug("project already finalized:", project.projectName, project.apiType);
        return project.module as ProjectPluginModule<T>;
    }

    const {
        resolveImmediate = true,
    } = project.getApiOptions(apiType);

    let apiModule = preferDefault(
        project.transpiler.transpile(init),
    ) as TranspilerReturn<T>;

    /**
     * If the module we're transpiling is using `useGatsbyConfig` or `useGatsbyNode`, then
     * it will already be doing the transpilation itself.  Just return that result.
     */
    if (project.finalized) {
        apiDebug("project finalized after transpile:", project.projectName, project.apiType);
        return project.module as ProjectPluginModule<T>;
    }

    let insertPlugin = false;
    if (apiType === "config" && !pluginInserted) {
        insertPlugin = pluginInserted = true;
    }

    let gatsbyNode: ProjectMetaFn<"node"> | undefined = undefined;
    let gatsbyNodeProject: Project<"node"> | undefined = undefined;

    if (apiType === "config") {
        const gatsbyNodePath = resolveFilePath(projectRoot, "./gatsby-node");

        /**
         * We want to pre-process `gatsby-node` from `gatsby-config` because:
         *
         * 1. We want to get all of the chained imports from `gatsby-node`; and,
         * 2. We want to transpile it in case it is a `.ts` file, so that Gatsby
         *    can consume it.
         */
        if (gatsbyNodePath) {
            project.setApiOption("node", "resolveImmediate", false);
            gatsbyNodeProject = project.clone("node");

            gatsbyNode = processApiModule({
                init: gatsbyNodePath,
                project: gatsbyNodeProject,
            }) as ProjectMetaFn<"node">;

            gatsbyNodeProject = project.getProject({
                apiType: "node",
                projectMeta: project.projectMeta,
            }, false, undefined, gatsbyNodeProject.debug);
            project.setApiOption("node", "resolveImmediate", true);
        }
    }

    if (!apiModule) apiModule = {};

    if (isProjectMetaFn(project, apiModule) && resolveImmediate) {
        apiModule = project.resolveConfigFn(
            apiModule as ProjectMetaFn<ApiType>,
        ) as ProjectPluginModule<T>;
    }

    if (
        gatsbyNodeProject &&
        !gatsbyNodeProject.finalized &&
        gatsbyNode &&
        isProjectMetaFn(project, gatsbyNode)
    ) {
        apiDebug("Finalize gatsby-node", gatsbyNodeProject.requirePath);
        gatsbyNodeProject.finalizeProject(
            gatsbyNodeProject.resolveConfigFn(gatsbyNode),
        );
    }

    /**
     * Time to transpile/process local plugins
     */
    if (
        isGatsbyConfig(apiType, apiModule)
        && typeof apiModule === "object"
    ) {
        if (recurse) {
            apiDebug("Resolving plugins");
            apiModule.plugins = processPluginCache(
                project,
                processApiModule,
                apiModule.plugins,
            );
        }
        if (insertPlugin) {
            const options: GatsbyTsPluginOptions = {
                gatsbyNodePath: gatsbyNodeProject?.requirePath || "",
            }
            apiModule.plugins = (apiModule.plugins || []).concat([
                {
                    resolve: path.dirname(require.resolve("../gatsby-plugin")),
                    options,
                }
            ])
        }
    }

    if (resolveImmediate) {
        apiDebug("Finalizing project:", project.requirePath, apiModule);
        project.finalizeProject(apiModule);
    }

    return apiModule as ProjectPluginModule<T>;
};