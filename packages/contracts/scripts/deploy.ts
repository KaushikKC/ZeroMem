import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying GrantRegistry with account:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('Account balance:', ethers.formatEther(balance), '0G');

  const GrantRegistry = await ethers.getContractFactory('GrantRegistry');
  const registry = await GrantRegistry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log('GrantRegistry deployed to:', address);
  console.log('');
  console.log('Add to your .env:');
  console.log(`GRANT_REGISTRY_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
