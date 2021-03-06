"use strict";

const pascalCase = camelCase => camelCase.slice(0, 1).toUpperCase() + camelCase.slice(1);

module.exports = class ServerlessCweSnsLambda {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.options = options;
        this.provider = serverless ? serverless.getProvider("aws") : null;
        this.custom = serverless.service ? serverless.service.custom : null;
        this.serviceName = serverless.service.service;

        if (!this.provider) {
            throw new Error("This plugin must be used with AWS");
        }
        /* Create schema for your properties. For reference use https://github.com/ajv-validator/ajv
        */
        serverless.configSchemaHandler.defineFunctionEvent('aws', 'cweSns', {
            type: 'object',
            properties: {
                ruleResourceName: { type: ["object", "string"] },
                topicArn: { type: ["object", "string"] },
                dlqArn: { type: ["object", "string"] },
                dlqUrl: { type: ["object", "string"] },
                dlqPolicyResourceName: { type: ["object", "string"] },
                ruleMessage: { type: ["object", "string"] },
                filterPolicy: { type: "object" }          
            },
            required: ["ruleResourceName"],
            additionalProperties: false,
        });

        this.hooks = {
            "aws:package:finalize:mergeCustomProviderResources": this.modifyTemplate.bind(this)
        };
    }

    /**
     * Mutate the CloudFormation template, adding the necessary resources for
     * the Lambda to subscribe to the SNS topics with error handling sqs attached
     * functionality built in.
     */
    modifyTemplate() {
        const functions = this.serverless.service.functions;
        const stage = this.serverless.service.provider.stage;
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;

        Object.keys(functions).forEach(funcKey => {
            const func = functions[funcKey];
            if (func.events) {
                func.events.forEach(event => {
                    if (event.cweSns) {
                        if (this.options.verbose) {
                            console.info(
                                `Adding cweSns event handler [${JSON.stringify(event.cweSns)}]`
                            );
                        }
                        this.addCweSnsResources(template, funcKey, stage, event.cweSns);
                    }
                });
            }
        });
    }

    /**
     * Validate the configuration values from the serverless config file,
     * returning a config object that can be passed to the resource setup
     * functions.
     *
     * @param {string} funcName the name of the function from serverless config
     * @param {string} stage the stage name from the serverless config
     * @param {object} config the configuration values from the cweSns event
     *  portion of the serverless function config
     */
    validateConfig(funcName, stage, config) {
        if (!config.ruleResourceName || !config.topicArn) {
            throw new Error(`Error:
              When creating an cweSns handler, you must define the rule name and topic arn.
              In function [${funcName}]

              Usage
              -----

                functions:
                  processEvent:
                    handler: handler.handler
                    events:
                      - cweSns:
                          ruleResourceName: string                              #required
                          topicArn: string                                      #required
                          dlqArn: string                                        #optional
                          dlqUrl: string                                        #optional
                          dlqResourceName:  string                              #optional
                          dlqPolicyResourceName : string                        #optional
                          ruleMessage: Input || InputPath || InputTransformer   #optional                         
                          filterPolicy: Object                                  #optional
                          prefix: string                                        #optional
              `);
        }

        const funcNamePascalCase = pascalCase(funcName);

        return {
            ...config,
            funcName: funcNamePascalCase,
            prefix: config.prefix || `${this.serviceName}-${stage}-`,
            topicResourceName: `${funcNamePascalCase}Topic`,
            topicPolicyResourceName: config.topicPolicyResourceName || "CWEtoSNSInsertPolicy",
            dlqResourceName: config.dlqResourceName || "SNSDeadLetterQueue",
            dlqPolicyResourceName: config.dlqPolicyResourceName || "SNStoDLQInsertPolicy",
            ruleMessage: config.ruleMessage || {},
            filterPolicy: config.filterPolicy || {}
        };
    }

    /**
     *
     * @param {object} template the template which gets mutated
     * @param {string} funcName the name of the function from serverless config
     * @param {string} stage the stage name from the serverless config
     * @param {object} cweSnsConfig the configuration values from the cweSns
     *  event portion of the serverless function config
     */
    addCweSnsResources(template, funcName, stage, cweSnsConfig) {
        const config = this.validateConfig(funcName, stage, cweSnsConfig);
        [
            this.addSNSDLQ,
            this.addCWEtoSNSPolicy,
            this.addSNStoDLQPolicy,
            this.addTopicToCloudWatchRule,
            this.addTopicSubscription,
            this.addEventInvocationPermission
        ].reduce((templ, func) => {
            func(templ, config);
            return templ;
        }, template);
    }

    addSNSDLQ(template, {prefix, dlqArn, dlqUrl, dlqResourceName}) {
        if (!dlqArn && !dlqUrl && !template.Resources[dlqResourceName]) {
            template.Resources[dlqResourceName] = {
                Type: "AWS::SQS::Queue",
                Properties: {
                    QueueName: `${prefix}${dlqResourceName}`,
                    MessageRetentionPeriod: 1209600 //14 days in seconds
                }
            };
        }
    }

    addTopicToCloudWatchRule(
        template,
        {topicArn, topicResourceName, ruleResourceName, ruleMessage}
    ) {
        if (
            !template.Resources[ruleResourceName] ||
            !template.Resources[ruleResourceName].Properties ||
            !template.Resources[ruleResourceName].Properties.Targets
        ) {
            throw new Error(
                `Invalid resource ${ruleResourceName} for a cwe rule. The resource must be defined and contain Properties and Targets. Found ${JSON.stringify(
                    template.Resources[ruleResourceName]
                )}`
            );
        } else if (template.Resources[ruleResourceName].Properties.Targets.length === 5) {
            throw new Error(`Maximum of 5 targets reached for ${ruleResourceName} rule`);
        } else {
            template.Resources[ruleResourceName].Properties.Targets.push({
                Arn: topicArn,
                Id: `ID${topicResourceName}`,
                ...ruleMessage
            });
        }
    }

    addSNStoDLQPolicy(
        template,
        {prefix, topicArn, dlqArn, dlqUrl, dlqResourceName, dlqPolicyResourceName}
    ) {
        if (!template.Resources[dlqPolicyResourceName]) {
            template.Resources[dlqPolicyResourceName] = {
                Type: "AWS::SQS::QueuePolicy",
                Properties: {
                    PolicyDocument: {
                        Version: "2012-10-17",
                        Id: `${prefix}${dlqPolicyResourceName}`,
                        Statement: []
                    },
                    Queues: []
                }
            };
        }
        template.Resources[dlqPolicyResourceName].Properties.Queues.push(
            dlqUrl || {
                Ref: dlqResourceName
            }
        );
        template.Resources[dlqPolicyResourceName].Properties.PolicyDocument.Statement.push({
            Sid: `Statement${template.Resources[dlqPolicyResourceName].Properties.PolicyDocument
                .Statement.length + 1}`,
            Effect: "Allow",
            Principal: {
                Service: "sns.amazonaws.com"
            },
            Action: "sqs:SendMessage",
            Resource: dlqArn || {"Fn::GetAtt": [dlqResourceName, "Arn"]},
            Condition: {
                ArnEquals: {
                    "aws:SourceArn": topicArn
                }
            }
        });
    }

    addCWEtoSNSPolicy(template, {prefix, topicArn, topicPolicyResourceName}) {
        if (!template.Resources[topicPolicyResourceName]) {
            template.Resources[topicPolicyResourceName] = {
                Type: "AWS::SNS::TopicPolicy",
                Properties: {
                    PolicyDocument: {
                        Version: "2012-10-17",
                        Id: `${prefix}CWEtoSNSInsertPolicy`,
                        Statement: []
                    },
                    Topics: []
                }
            };
        }
        template.Resources[topicPolicyResourceName].Properties.Topics.push(topicArn);
        template.Resources[topicPolicyResourceName].Properties.PolicyDocument.Statement.push({
            Sid: `Statement${template.Resources[topicPolicyResourceName].Properties.PolicyDocument
                .Statement.length + 1}`,
            Effect: "Allow",
            Principal: {
                Service: ["events.amazonaws.com"]
            },
            Action: ["sns:Publish"],
            Resource: topicArn
        });
    }

    addTopicSubscription(
        template,
        {funcName, topicArn, topicResourceName, dlqArn, dlqResourceName, filterPolicy}
    ) {
        template.Resources[`SubscribeTo${topicResourceName}`] = {
            Type: "AWS::SNS::Subscription",
            Properties: {
                TopicArn: topicArn,
                Endpoint: {
                    "Fn::GetAtt": [`${funcName}LambdaFunction`, "Arn"]
                },
                Protocol: "lambda",
                RedrivePolicy: {
                    deadLetterTargetArn: dlqArn || {"Fn::GetAtt": [dlqResourceName, "Arn"]}
                },
                FilterPolicy: filterPolicy
            }
        };
    }

    addEventInvocationPermission(template, {funcName, topicArn, topicResourceName}) {
        template.Resources[`${funcName}InvokeFrom${topicResourceName}`] = {
            Type: "AWS::Lambda::Permission",
            Properties: {
                FunctionName: {
                    "Fn::GetAtt": [`${funcName}LambdaFunction`, "Arn"]
                },
                Action: "lambda:InvokeFunction",
                Principal: "sns.amazonaws.com",
                SourceArn: topicArn
            }
        };
    }
};
