import * as cdk from "@aws-cdk/core";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";
import route53 = require('@aws-cdk/aws-route53');
import { Duration, RemovalPolicy } from "@aws-cdk/core";
import acm = require('@aws-cdk/aws-certificatemanager');
import * as s3deploy from "@aws-cdk/aws-s3-deployment";
const { NodejsFunction } = require("@aws-cdk/aws-lambda-nodejs");
import { Runtime } from "@aws-cdk/aws-lambda";
import * as apigateway from "@aws-cdk/aws-apigateway";
import targets = require('@aws-cdk/aws-route53-targets/lib');
import { LambdaEdgeEventType } from "@aws-cdk/aws-cloudfront";

export class CdkApiLambdaS3CloudfrontStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    const redirectLambda = new NodejsFunction(this, "RedirectLambda", {
      entry: `${__dirname}/redirect/index.ts`,
      handler: "handler",
      runtime: Runtime.NODEJS_12_X,
    });
    const siteDomain = 'iharshit.site'
    const subDomain = 'blog' + '.' + siteDomain;
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: siteDomain });
    new cdk.CfnOutput(this, 'Site', { value: 'https://' + siteDomain });

    const restApi = new apigateway.RestApi(this, "Cargo API", {
      restApiName: 'Cargo Service'
    });

    const items = restApi.root.addResource('items');

    const helloWorldLambda = new NodejsFunction(this, "HelloWorldLambda", {
      functionName: 'createItemFunction',
      entry: `${__dirname}/backend/index.ts`,
      handler: "handler",
      runtime: Runtime.NODEJS_12_X,
    });

    const lambdaIntegration = new apigateway.LambdaIntegration(helloWorldLambda);
    items.addMethod('GET', lambdaIntegration);
    addCorsOptions(items);

    const cloudfrontOAI = new cloudfront.OriginAccessIdentity(
      this,
      "CloudFrontOAI",
      {
        comment: `Allows CloudFront access to S3 bucket`,
      }
    );

    const websiteBucket = new s3.Bucket(this, "MyBucket", {
      removalPolicy: RemovalPolicy.DESTROY, // Using destroy so when you delete this stack, we will remove the S3 bucket created as well
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.GET],
          maxAge: 3000,
        },
      ],
    });

    // uploads index.html to s3 bucket
    new s3deploy.BucketDeployment(this, "DeployWebsite", {
      sources: [s3deploy.Source.asset(`${__dirname}/frontend`)],
      destinationBucket: websiteBucket,
    });

    websiteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "Grant Cloudfront Origin Access Identity access to S3 bucket",
        actions: ["s3:GetObject"],
        resources: [websiteBucket.bucketArn + "/*"],
        principals: [cloudfrontOAI.grantPrincipal],
      })
    );

    const certificateArn = new acm.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName: siteDomain,
      hostedZone: zone,
      region: 'us-east-1', // Cloudfront only checks this region for certificates.
    }).certificateArn;

    new cdk.CfnOutput(this, 'Certificate', { value: certificateArn });

    const distribution = new cloudfront.CloudFrontWebDistribution(this, "CargoDistribution", {
      comment: "CDN for Cargo APIs",
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      aliasConfiguration: {
        acmCertRef: certificateArn,
        names: [siteDomain],
        sslMethod: cloudfront.SSLMethod.SNI,
        securityPolicy: cloudfront.SecurityPolicyProtocol.TLS_V1_1_2016,
      },
      originConfigs: [
        {
          // make sure your backend origin is first in the originConfigs list so it takes precedence over the S3 origin
          customOriginSource: {
            domainName: `${restApi.restApiId}.execute-api.${this.region}.amazonaws.com`,
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              pathPattern: "*", // CloudFront will forward `/api/*` to the backend so make sure all your routes are prepended with `/api/`
              allowedMethods: cloudfront.CloudFrontAllowedMethods.ALL,
              // defaultTtl: Duration.seconds(0),
              forwardedValues: {
                queryString: true,
                headers: ["Authorization"], // By default CloudFront will not forward any headers through so if your API needs authentication make sure you forward auth headers across
              },
            },
          ],
        }
        // ,{
        //   s3OriginSource: {
        //     s3BucketSource: websiteBucket,
        //     originAccessIdentity: cloudfrontOAI,
        //   },
        //   behaviors: [
        //     {
        //       compress: true,
        //       isDefaultBehavior: true,
        //       // defaultTtl: Duration.seconds(0),
        //       allowedMethods:
        //         cloudfront.CloudFrontAllowedMethods.GET_HEAD_OPTIONS,
        //       // lambdaFunctionAssociations: [
        //       //   {
        //       //     lambdaFunction: redirectLambda.currentVersion,
        //       //     eventType: LambdaEdgeEventType.ORIGIN_RESPONSE,
        //       //   },
        //       // ],
        //     },
        //   ],
        // },
      ],
    });

    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    // Route53 alias record for the CloudFront distribution
    new route53.ARecord(this, 'SiteAliasRecord', {
      recordName: siteDomain,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      zone
  });
  }
}

export function addCorsOptions(apiResource: apigateway.IResource) {
  apiResource.addMethod('OPTIONS', new apigateway.MockIntegration({
    integrationResponses: [{
      statusCode: '200',
      responseParameters: {
        'method.response.header.Access-Control-Allow-Headers': "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
        'method.response.header.Access-Control-Allow-Origin': "'*'",
        'method.response.header.Access-Control-Allow-Credentials': "'false'",
        'method.response.header.Access-Control-Allow-Methods': "'OPTIONS,GET,PUT,POST,DELETE'",
      },
    }],
    passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
    requestTemplates: {
      "application/json": "{\"statusCode\": 200}"
    },
  }), {
    methodResponses: [{
      statusCode: '200',
      responseParameters: {
        'method.response.header.Access-Control-Allow-Headers': true,
        'method.response.header.Access-Control-Allow-Methods': true,
        'method.response.header.Access-Control-Allow-Credentials': true,
        'method.response.header.Access-Control-Allow-Origin': true,
      },
    }]
  })
}